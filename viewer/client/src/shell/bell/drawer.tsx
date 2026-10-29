/**
 * The bell — two questions, over whatever page you are on (7.0 in
 * quiet-console phase 5; `?bell=1`).
 *
 * **Needs you** is a PREVIEW of the inbox (`GET /api/inbox`, #377): at most
 * five rows, one line each, under the door to Your turn (`#/turn`), where every
 * item is and where it is acted on. More than five says how many more wait
 * there. One query with the Runs page, so acting from either surface updates
 * the other in the same tick.
 *
 * **Announcements** is the log of what the console has SAID — every row says
 * what was announced and what became of it, because a silent delivery failure
 * is exactly the thing that is invisible otherwise.
 *
 * Two halves of one sheet rather than one merged list: "this still needs you"
 * and "this was announced at 04:12 and reached no device" are different
 * questions with different lifetimes — an inbox row leaves when the thing it
 * is about is fixed, an announcement never does.
 *
 * The address is the state: `?bell=1` opens it, `?panel=` picks the half,
 * `?unread=` and `?category=` narrow the announcements, and closing takes all
 * of them with it (`closeOverlaysHref`). A push deep-links straight in; a
 * reload loses nothing.
 *
 * ## One scroller, and the bulk bar is not in it
 *
 * The sheet's body is a column three rows deep — the filters, the list, the
 * bulk bar — and only the list scrolls. A bar in flow under a hundred-row
 * inbox is a hundred rows past the fold, and an operator who cannot reach a
 * control has the same experience as one for whom it was never built.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { SEVERITY_UI, attentionCount } from '@shared/attention-model.js';
import { isDeliveryPlaceholder } from '@shared/ops-vocab.js';
import {
  api,
  partitionAsks,
  type InboxItem,
  type NotificationCategory,
  type NotificationRecord,
} from '@/data/api';
import { useAttentionInbox, useInbox } from '@/data/inbox';
import { keys } from '@/data/keys';
import { press } from '@/data/press';
import { plural } from '@/lib/format';
import { cn } from '@/lib/cn';
import { useInboxActions } from '@/cards/inbox-row';
import { TurnRowWords } from '@/cards/turn/row-words';
import { useNavigate } from '@/shell/router';
import {
  OVERLAY_KEYS,
  PANEL_KEYS,
  bellHref,
  closeOverlaysHref,
  panelOf,
  plansHref,
  settingsHref,
  toHash,
  turnHref,
  type PanelKey,
  type Route,
} from '@/shell/routes';
import { Banner, Button, ButtonGroup, Empty, RelativeTime, SectionHeading, Skeleton, toast } from '@/ui';
import { Checkbox } from '@/ui/checkbox';
import { ConfirmButton } from '@/ui/confirm';
import { Sheet, SheetContent } from '@/ui/sheet';
import { useSelection } from './selection';
import { SelectionBar } from './selection-bar';

/** How many rows one page of the announcements holds before "Show older". */
const PAGE = 40;

/** The announcements panel's two query keys; `closeOverlaysHref` drops both with the drawer. */
const FILTER_KEYS = { unread: 'unread', category: 'category' } as const;

type FilterPatch = Partial<Record<'unread' | 'category', string | null>>;

export interface DrawerFilters {
  unread: boolean;
  category?: string;
}

/** What the address asks the announcements panel to show. */
function filtersOf(route: Route): DrawerFilters {
  const category = route.query[FILTER_KEYS.category];
  return {
    unread: route.query[FILTER_KEYS.unread] === '1',
    ...(category ? { category } : {}),
  };
}

/**
 * The drawer's address with one filter changed — composed by handing
 * `bellHref` a route whose query already says what we want, rather than
 * assembling a hash here, which is how two spellings of one address drift.
 */
function filterHref(route: Route, panel: PanelKey, next: FilterPatch): string {
  const query = { ...route.query };
  for (const [key, value] of Object.entries(next)) {
    if (value == null || value === '') delete query[key];
    else query[key] = value;
  }
  return bellHref({ ...route, query }, panel);
}

/** A refusal in the server's own words — the honest floor when it said nothing. */
const failed = (cause: unknown) =>
  cause instanceof Error && cause.message ? cause.message : 'The press failed and said nothing.';

/**
 * The bell drawer. Open ⟺ the address says `?bell=`; it is mounted only then
 * (`App.tsx` loads this chunk on the overlay), and each half holds its paged
 * query only while it is the half on screen.
 */
export function BellDrawer({ route }: { route: Route }) {
  const navigate = useNavigate();
  const open = route.query[OVERLAY_KEYS.bell] != null;
  // Needs-you first: the bell is opened from a count of things still
  // waiting. `#/notifications` — the retired page — asks for its half by name.
  const panel = panelOf(route) ?? PANEL_KEYS.inbox;
  const inbox = useAttentionInbox(false, open);
  const waiting = attentionCount(inbox.data?.items);

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) navigate(closeOverlaysHref(route));
      }}
    >
      {/* At the end on a desk — a list beside the page, not over it — and at
          the bottom on a phone, where the thumb is. The body hands the
          scrolling DOWN: it is a column that scrolls nothing (`-y-`, the one
          spelling that displaces the sheet's own `overflow-y-auto`), and one
          box inside each half does. */}
      <SheetContent
        side="auto"
        size="reading"
        title="Inbox"
        showTitle
        bodyClassName="flex flex-col overflow-y-hidden p-0"
        subheader={
          <div className="flex min-w-0 items-center py-2">
            <ButtonGroup aria-label="Which list">
              <Button
                size="sm"
                variant="ghost"
                aria-pressed={panel === PANEL_KEYS.inbox}
                onClick={() =>
                  navigate(filterHref(route, PANEL_KEYS.inbox, { unread: null, category: null }))
                }
              >
                Needs you
                {waiting > 0 && (
                  <span className="text-ink-muted tabular-nums">
                    <span className="sr-only">,</span> {waiting}
                  </span>
                )}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                aria-pressed={panel === PANEL_KEYS.announcements}
                onClick={() =>
                  navigate(filterHref(route, PANEL_KEYS.announcements, { unread: null, category: null }))
                }
              >
                Announcements
              </Button>
            </ButtonGroup>
          </div>
        }
      >
        {open &&
          (panel === PANEL_KEYS.inbox ? (
            <NeedsYouPanel
              items={inbox.data?.items}
              loading={inbox.isPending}
              onOpen={(url) => navigate(toHash(url))}
            />
          ) : (
            <DrawerBody
              filters={filtersOf(route)}
              onFilters={(next) => navigate(filterHref(route, PANEL_KEYS.announcements, next))}
              onOpen={(url) => navigate(toHash(url))}
            />
          ))}
      </SheetContent>
    </Sheet>
  );
}

export default BellDrawer;

/** The scrolling middle of a half — the ONE box in the drawer that scrolls. */
function PanelScroller({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      data-testid="drawer-scroller"
      className={cn('min-h-0 flex-1 overflow-y-auto overscroll-contain', className)}
    >
      {children}
    </div>
  );
}

/** How many needs-you rows the bell previews; the rest wait on Your turn (#377). */
export const PREVIEW_ROWS = 5;

/**
 * The needs-you PREVIEW (#377): at most five rows, one line each, and the door
 * to the page at its top. The bell is where a person glances; Your turn is
 * where they act — so a row here is its marks, its title cut to one line and
 * its clock, and the remedies live on the page and the card. Live asks lead,
 * as they do everywhere: a session stopped dead outranks an errand.
 *
 * The bar offers acknowledgement only — a two-inch sheet is not where anyone
 * should be starting four recovery sessions. It acts on what is shown; its
 * *Acknowledge all* names, in its confirm, every row that waits.
 */
function NeedsYouPanel({
  items,
  loading,
  onOpen,
}: {
  items: InboxItem[] | undefined;
  loading: boolean;
  onOpen: (url: string) => void;
}) {
  const { ackMany, unackMany, bulkBusy } = useInboxActions();
  const rows = useMemo(() => items ?? [], [items]);
  // Asks first, then the rest, each half in the server's own order — then cut.
  const { asks, shown } = useMemo(() => {
    const parts = partitionAsks(rows);
    return { asks: parts.asks, shown: [...parts.asks, ...parts.rest].slice(0, PREVIEW_ROWS) };
  }, [rows]);
  const pick = useSelection(shown);
  const picked = useMemo(() => shown.filter((item) => pick.has(item.id)), [shown, pick]);
  const unacked = useMemo(() => rows.filter((item) => !item.ack), [rows]);
  const allAcked = picked.length > 0 && picked.every((item) => item.ack);
  const more = rows.length - shown.length;

  if (loading && !items) {
    return (
      <PanelScroller className="flex flex-col gap-2 p-4">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-7" />
        ))}
      </PanelScroller>
    );
  }

  if (!items?.length) {
    return (
      <PanelScroller className="px-4 py-2">
        <Empty
          title="Nothing needs you."
          action={
            <Button size="sm" asChild>
              <a href={plansHref()}>Open Plans</a>
            </Button>
          }
        />
      </PanelScroller>
    );
  }

  // Headed only when both halves are on screen; a heading over a list of
  // everything says nothing.
  const shownAsks = shown.filter((item) => asks.includes(item));
  const shownRest = shown.filter((item) => !asks.includes(item));
  const row = (item: InboxItem) => (
    <PreviewRow
      key={item.id}
      item={item}
      checked={pick.has(item.id)}
      onCheck={(extend) => pick.toggle(item.id, extend)}
      onOpen={onOpen}
    />
  );

  return (
    <>
      {/* The door, above the list and outside its scroller: the page is where
          every item is, and the drawer only ever shows a few of them. */}
      <div className="flex min-w-0 shrink-0 items-center gap-3 border-b border-rule px-4 py-2">
        <Button size="sm" variant="primary" asChild>
          <a href={turnHref()} data-testid="bell-turn-door">
            Open Your turn
          </a>
        </Button>
        <span className="text-meta text-ink-muted tabular-nums">{plural(rows.length, 'thing')} waiting</span>
      </div>
      <PanelScroller>
        {!shownAsks.length || !shownRest.length ? (
          <ul className="flex flex-col gap-1 px-4 py-3">{shown.map(row)}</ul>
        ) : (
          <div className="flex flex-col gap-2 px-4 py-3">
            <SectionHeading as="h3" count={asks.length}>
              Sessions asking you
            </SectionHeading>
            <ul className="flex flex-col gap-1">{shownAsks.map(row)}</ul>
            <SectionHeading as="h3" className="mt-3 border-t border-rule pt-3">
              Also waiting
            </SectionHeading>
            <ul className="flex flex-col gap-1">{shownRest.map(row)}</ul>
          </div>
        )}
        {more > 0 && (
          <p className="px-4 pb-3 text-meta" data-testid="bell-turn-more">
            <a href={turnHref()} className="text-ink underline underline-offset-2">
              {more} more on Your turn
            </a>
          </p>
        )}
      </PanelScroller>
      <SelectionBar
        dock
        count={pick.count}
        state={pick.state}
        onToggleAll={pick.toggleAll}
        onClear={pick.clear}
        verbs={[]}
        onVerb={() => {}}
        // The word is the press: every ticked row already acknowledged puts
        // them back; anything else acknowledges.
        acknowledgeLabel={allAcked ? 'Put back' : 'Acknowledge'}
        onAcknowledge={() => {
          const undo = pick.ids;
          if (allAcked) unackMany(picked.map((item) => item.id));
          else ackMany(picked, () => pick.restore(undo));
          pick.clear();
        }}
        busy={bulkBusy}
      >
        <ConfirmButton
          size="sm"
          disabled={bulkBusy || unacked.length === 0}
          busy={bulkBusy}
          title={`Acknowledge ${plural(unacked.length, 'thing')}?`}
          description="Acknowledged is seen, not cleared: nothing is fixed, and every one of them comes back if what it is about changes. The undo runs for ten seconds."
          confirmLabel="Acknowledge them"
          details={
            // Named, not counted: a number says how many, the list says
            // whether they are the ones you meant.
            <ul className="flex max-h-40 list-disc flex-col gap-0.5 overflow-y-auto ps-4 text-meta text-ink-muted">
              {unacked.map((item) => (
                <li key={item.id}>{item.title}</li>
              ))}
            </ul>
          }
          // No restore on undo: nothing was ticked to put back.
          onConfirm={() => ackMany(unacked)}
        >
          Acknowledge all
        </ConfirmButton>
      </SelectionBar>
    </>
  );
}

/**
 * One needs-you row in the preview — ONE line: the pick, the card's marks (NOW
 * or NOT YET and the type; the *when* is the page's), the title cut by CSS to
 * the line it has (whole in the link's name and its hover), and the clock.
 * Its leading edge wears the severity's paint, as the page's rows do.
 */
function PreviewRow({
  item,
  checked,
  onCheck,
  onOpen,
}: {
  item: InboxItem;
  checked: boolean;
  onCheck: (extend: boolean) => void;
  onOpen: (url: string) => void;
}) {
  const href = toHash(item.href);
  const since = Date.parse(item.since);
  const paint = SEVERITY_UI[item.severity] ?? 'queued';
  return (
    <li
      data-testid="inbox-row"
      data-kind={item.kind}
      data-severity={item.severity}
      data-checked={checked || undefined}
      className={cn(
        `state-${paint}`,
        'flex min-w-0 items-center gap-2 border-s-2 py-1.5 pe-1 ps-3',
        item.ack ? 'border-rule-strong' : 'border-state',
        checked && 'bg-surface-raised',
      )}
    >
      <Checkbox
        checked={checked}
        onClick={(event) => onCheck(event.shiftKey)}
        onCheckedChange={() => {}}
        aria-label={`${checked ? 'Unpick' : 'Pick'} ${item.title}`}
      />
      <TurnRowWords
        turn={item.turn && { ...item.turn, startWhen: undefined }}
        className="shrink-0 flex-nowrap"
      />
      {/* `relative`: a positioned link hit-tests above the pick box's
          thumb-floor overlay, which overhangs its 16 px box. */}
      <a
        href={href}
        title={item.title}
        aria-label={item.title}
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
          event.preventDefault();
          onOpen(href);
        }}
        className="relative min-w-0 flex-1 truncate font-medium text-ink hover:underline"
      >
        {item.title}
      </a>
      {Number.isFinite(since) && <RelativeTime at={since} className="shrink-0 text-meta text-ink-faint" />}
    </li>
  );
}

/** Day headings, newest first, with the two everyone actually reads named. */
export function groupByDay(items: NotificationRecord[]): [string, NotificationRecord[]][] {
  const today = new Date().toDateString();
  const yesterday = new Date(Date.now() - 86_400_000).toDateString();
  const out = new Map<string, NotificationRecord[]>();
  for (const item of items) {
    const at = new Date(item.at);
    const key = Number.isNaN(at.getTime())
      ? 'Undated'
      : at.toDateString() === today
        ? 'Today'
        : at.toDateString() === yesterday
          ? 'Yesterday'
          : at.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    const bucket = out.get(key);
    if (bucket) bucket.push(item);
    else out.set(key, [item]);
  }
  return [...out.entries()];
}

/** What became of one announcement, in the fewest words that are still true. */
export function deliverySummary(item: NotificationRecord): { text: string; failed: boolean } {
  // The two placeholders (`no-device`, `skipped`) name no device and are no
  // failed handover: dropped before counting, so a ledger of only those reads
  // as the empty one it stands for (#324).
  const delivered = (item.delivery ?? []).filter((d) => !isDeliveryPlaceholder(d.outcome));
  if (!delivered.length) return { text: 'no device', failed: false };
  // `quiet` is a device inside its own quiet hours: nothing was attempted, on
  // purpose — neither a delivery nor a failure, or every night would read red.
  const quiet = delivered.filter((d) => d.outcome === 'quiet').length;
  const failures = delivered.filter((d) => d.outcome !== 'sent' && d.outcome !== 'quiet');
  if (failures.length) return { text: `${failures.length}/${delivered.length} not delivered`, failed: true };
  if (quiet === delivered.length) return { text: 'held by quiet hours', failed: false };
  if (quiet) return { text: `sent to ${delivered.length - quiet}, ${quiet} quiet`, failed: false };
  return { text: `sent to ${delivered.length}`, failed: false };
}

/**
 * The category chips a filter row offers: what has actually been announced,
 * named as the push catalogue names it, in the catalogue's graded order (so
 * the chips do not reshuffle as records arrive). An id the catalogue does not
 * carry sorts to the end under its own name rather than disappearing.
 */
export function categoryChips(
  seen: Iterable<string>,
  registry: readonly NotificationCategory[],
): { id: string; label: string }[] {
  const known = new Map(registry.map((category, index) => [category.id, { index, label: category.label }]));
  const last = registry.length;
  return [...new Set(seen)]
    .map((id) => ({ id, label: known.get(id)?.label ?? id }))
    .sort(
      (a, b) =>
        (known.get(a.id)?.index ?? last) - (known.get(b.id)?.index ?? last) || a.id.localeCompare(b.id),
    );
}

/**
 * The announcements. Mounted only while this half shows — it is a paged
 * server query. Three rows: the filters, the list, the bulk bar; only the list
 * scrolls, so neither what narrows the list nor what acts on it can be
 * scrolled off the screen.
 */
export function DrawerBody({
  filters,
  onFilters,
  onOpen,
}: {
  filters: DrawerFilters;
  onFilters: (next: FilterPatch) => void;
  onOpen: (url: string) => void;
}) {
  const client = useQueryClient();
  const [limit, setLimit] = useState(PAGE);
  const [busy, setBusy] = useState(false);
  // A page cursor is not an address: narrowing starts again from the top.
  useEffect(() => setLimit(PAGE), [filters.unread, filters.category]);

  const { data, isPending } = useInbox({
    ...(filters.unread ? { unread: true } : {}),
    ...(filters.category ? { category: filters.category } : {}),
    limit,
  });
  const pick = useSelection(useMemo(() => data?.items ?? [], [data?.items]));

  // Grows only. See `categoryChips`.
  const seen = useRef<string[]>([]);
  const chips = useMemo(() => {
    for (const item of data?.items ?? [])
      if (!seen.current.includes(item.category)) seen.current.push(item.category);
    if (filters.category && !seen.current.includes(filters.category)) seen.current.push(filters.category);
    return categoryChips(seen.current, data?.categories ?? []);
  }, [data?.items, data?.categories, filters.category]);

  /*
   * One write, six verbs. What is shared is that a failure is said out loud
   * and the list is re-read either way — on failure most of all (a record
   * cleared in another tab answers 404 here, and the phantom has to go).
   * `/api/state` rides in the bundle because the bell's own count lives there.
   */
  const act = (call: () => Promise<unknown>) => {
    setBusy(true);
    press(call)
      .then((pressed) => {
        if (pressed.state === 'asked') toast(pressed.words, 'info', 8000);
      })
      .catch((cause: unknown) => toast(failed(cause), 'error'))
      .finally(() => {
        setBusy(false);
        for (const queryKey of keys.afterAnnouncement()) void client.invalidateQueries({ queryKey });
      });
  };

  // The URL is whatever `routeFor` built on the server — never assembled here.
  const open = (item: NotificationRecord) => {
    const go = () => onOpen(item.url);
    if (item.read) return go();
    api
      .markNotificationsRead([item.id])
      .catch(() => undefined)
      .finally(() => {
        for (const queryKey of keys.afterAnnouncement()) void client.invalidateQueries({ queryKey });
        go();
      });
  };

  if (isPending && !data) {
    return (
      <PanelScroller className="flex flex-col gap-3 p-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-14" />
        ))}
      </PanelScroller>
    );
  }

  if (!data) return null;

  const groups = groupByDay(data.items);
  const nothingCanArrive = data.devices === 0 && !data.outOfBand?.configured;
  const narrowed = filters.unread || Boolean(filters.category);

  return (
    <>
      <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-1.5 border-b border-rule px-4 py-2">
        <Button
          size="sm"
          variant={filters.unread ? 'default' : 'ghost'}
          aria-pressed={filters.unread}
          onClick={() => onFilters({ unread: filters.unread ? null : '1' })}
        >
          Unread only
        </Button>
        {/* Once there is a choice to make — or one to undo: a cold reload into
            `?category=x` sees one category, and a row that hid itself there
            would be a filter with no way out of it. */}
        {(chips.length > 1 || filters.category) && (
          <div
            role="group"
            aria-label="Filter by category"
            className="flex min-w-0 flex-wrap items-center gap-1.5"
          >
            <Button
              size="sm"
              variant={filters.category ? 'ghost' : 'default'}
              aria-pressed={!filters.category}
              onClick={() => onFilters({ category: null })}
            >
              All
            </Button>
            {chips.map((chip) => (
              <Button
                key={chip.id}
                size="sm"
                variant={filters.category === chip.id ? 'default' : 'ghost'}
                aria-pressed={filters.category === chip.id}
                // The word each ROW wears, so the filter and what it keeps
                // need no explaining; the catalogue's sentence is the hover.
                title={chip.label}
                onClick={() => onFilters({ category: filters.category === chip.id ? null : chip.id })}
              >
                {chip.id}
              </Button>
            ))}
          </div>
        )}
      </div>

      <PanelScroller className="flex flex-col gap-4 px-4 py-3">
        {nothingCanArrive && (
          <Banner severity="info">
            <span className="font-medium">Nothing can reach you out of band yet.</span> No device is
            subscribed and no <code className="font-mono">PHASE_CONSOLE_NOTIFY</code> command is set, so these
            arrive here and nowhere else.{' '}
            <a href={settingsHref('notifications')} className="text-ink underline underline-offset-2">
              Set a device up
            </a>
            .
          </Banner>
        )}

        {!data.items.length ? (
          narrowed ? (
            <Empty
              title="Nothing matches"
              action={
                <Button size="sm" onClick={() => onFilters({ unread: null, category: null })}>
                  Clear the filters
                </Button>
              }
            />
          ) : (
            <Empty
              title="Nothing announced yet."
              action={
                <Button size="sm" asChild>
                  <a href={settingsHref('notifications')}>Choose what to be told</a>
                </Button>
              }
            />
          )
        ) : (
          groups.map(([day, items]) => (
            <section key={day} className="flex flex-col gap-1">
              <SectionHeading as="h3">{day}</SectionHeading>
              <ul className="flex flex-col">
                {items.map((item) => (
                  <DrawerRow
                    key={item.id}
                    item={item}
                    checked={pick.has(item.id)}
                    onCheck={(extend) => pick.toggle(item.id, extend)}
                    onOpen={() => open(item)}
                    onClear={() => act(() => api.clearNotifications({ id: item.id }))}
                  />
                ))}
              </ul>
            </section>
          ))
        )}

        {data.more && (
          <div>
            <Button size="sm" onClick={() => setLimit(limit + PAGE)}>
              Show older
            </Button>
          </div>
        )}
      </PanelScroller>

      <SelectionBar
        dock
        count={pick.count}
        state={pick.state}
        onToggleAll={pick.toggleAll}
        onClear={pick.clear}
        // Reading is this list's own verb; acknowledging is the other list's.
        // *Delete* is the ticked rows' delete — said as one, never as an undo.
        verbs={[
          { verb: 'read', label: 'Mark read' },
          { verb: 'delete', label: 'Delete' },
        ]}
        onVerb={(verb) => {
          const ids = pick.ids;
          if (verb === 'delete')
            act(async () => {
              for (const id of ids) await api.clearNotifications({ id });
            });
          else act(() => api.markNotificationsRead(ids));
          pick.clear();
        }}
        // *Put back* is a real put-back (#334): the ticked records stay in the
        // list, unread again. It once deleted them under this word.
        acknowledgeLabel="Put back"
        onAcknowledge={() => {
          const ids = pick.ids;
          act(() => api.markNotificationsUnread(ids));
          pick.clear();
        }}
        busy={busy}
      >
        {/* The whole-list verbs, in the bar the selection verbs use, so "for
            these" and "for all" read as one family. */}
        <Button
          size="sm"
          disabled={busy || data.unread === 0}
          onClick={() => act(() => api.markNotificationsRead())}
        >
          Mark all read
        </Button>
        <Button
          size="sm"
          disabled={busy || !data.total}
          onClick={() => act(() => api.clearNotifications('read'))}
        >
          Clear read
        </Button>
        {/* The only irreversible thing in here: it asks, and says how many. */}
        <ConfirmButton
          size="sm"
          variant="danger"
          disabled={busy || !data.total}
          title={`Delete all ${plural(data.total, 'notification')}?`}
          description="This cannot be undone. Delivery history goes with them."
          confirmLabel="Delete them"
          destructive
          onConfirm={() => act(() => api.clearNotifications('all'))}
        >
          Clear all
        </ConfirmButton>
      </SelectionBar>
    </>
  );
}

/** One announcement: what was said, when, and what became of it — one line and its words. */
function DrawerRow({
  item,
  checked = false,
  onCheck,
  onOpen,
  onClear,
}: {
  checked?: boolean;
  onCheck?: (extend: boolean) => void;
  item: NotificationRecord;
  onOpen: () => void;
  onClear: () => void;
}) {
  const delivered = item.delivery ?? [];
  const summary = deliverySummary(item);
  return (
    <li
      data-checked={checked || undefined}
      data-read={item.read || undefined}
      className={cn(
        'flex min-w-0 items-start gap-3 border-t border-rule py-2.5 first:border-t-0',
        checked && 'bg-surface-raised',
      )}
    >
      {onCheck && (
        <Checkbox
          checked={checked}
          onClick={(event) => onCheck(event.shiftKey)}
          onCheckedChange={() => {}}
          className="mt-1"
          aria-label={`${checked ? 'Unpick' : 'Pick'} ${item.title}`}
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {/* A real link, so it opens in a background tab; a plain press also
            marks it read, which a bare href cannot do. */}
        <a
          href={toHash(item.url)}
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
            event.preventDefault();
            onOpen();
          }}
          className="flex min-w-0 flex-col gap-0.5 hover:underline"
        >
          <span className="flex min-w-0 items-baseline justify-between gap-3">
            <span
              className={cn(
                'min-w-0 truncate text-body',
                item.read ? 'text-ink-muted' : 'font-medium text-ink',
              )}
            >
              {item.title}
            </span>
            {/* `live={false}`: the log runs to hundreds of rows and none of their
                clocks ever moves — one shared interval would repaint them all. */}
            <RelativeTime at={item.at} live={false} className="shrink-0 text-meta text-ink-faint" />
          </span>
          <span className="text-meta text-ink-muted">{item.body}</span>
        </a>
        <p className="flex min-w-0 flex-wrap gap-x-3 gap-y-0.5 text-meta text-ink-muted">
          <span>{item.category}</span>
          {item.resolved ? (
            <span title={item.resolved.reason ? `Resolved on its own — ${item.resolved.reason}` : undefined}>
              Resolved itself
            </span>
          ) : (
            item.urgent && <span>Urgent</span>
          )}
          <span
            className={summary.failed ? 'text-failed' : undefined}
            title={
              delivered.length
                ? delivered
                    .map((d) => `${d.label}: ${d.outcome}${d.detail ? ` (${d.detail})` : ''}`)
                    .join('\n')
                : 'No device was subscribed when this was announced'
            }
          >
            {summary.text}
          </span>
        </p>
        {item.callback && item.actions?.length && !item.resolved ? <NotificationActions item={item} /> : null}
      </div>
      <Button
        size="icon"
        variant="ghost"
        onClick={onClear}
        aria-label={`Remove “${item.title}”`}
        className="shrink-0 text-ink-faint hover:text-failed"
      >
        <X size={16} aria-hidden />
      </Button>
    </li>
  );
}

/**
 * The buttons the phone's notification offered, offered here too (control-tower
 * phase 25): pressed through `POST /api/push/action` with the notification's
 * own one-shot token, so an answer given here is the answer — a phone's later
 * press is told it was already answered, and the other way round.
 */
export function NotificationActions({ item }: { item: NotificationRecord }) {
  const [said, setSaid] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (said) {
    return (
      <p className="text-meta text-ink-muted" role="status" data-testid="notification-answered">
        {said}
      </p>
    );
  }
  return (
    <div className="flex flex-wrap gap-1.5 pt-1" data-testid="notification-actions">
      {(item.actions ?? []).map((one) => (
        <Button
          key={one.action}
          size="sm"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            api
              .pushAction(item.callback!, one.action)
              .then(() => setSaid(`${one.title} — answered.`))
              .catch((error: Error) => setSaid(error.message))
              .finally(() => setBusy(false));
          }}
        >
          {one.title}
        </Button>
      ))}
    </div>
  );
}
