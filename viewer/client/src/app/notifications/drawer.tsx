import { useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { api, type InboxItem, type NotificationCategory, type NotificationRecord } from '@/lib/api';
import { keys, useApiMutation, useAttentionInbox, useInbox } from '@/lib/queries';
import { plural } from '@/lib/format';
import { usePhone } from '@/lib/media';
import { cn } from '@/lib/cn';
import {
  Banner,
  Button,
  Checkbox,
  Chip,
  ConfirmButton,
  CountBadge,
  Empty,
  RelativeTime,
  SectionHeading,
  Sheet,
  SheetContent,
  Skeleton,
} from '@/components/ui';
import { InboxRow, useInboxActions } from '@/features/now/inbox-row';
import { useSelection } from '@/features/now/selection';
import { SelectionBar } from '@/features/now/selection-bar';
import { needsYouCount, partitionAsks } from '@/features/now/model';
import { useNavigate } from '@/app/router';
import {
  OVERLAY_KEYS,
  PANEL_KEYS,
  bellHref,
  closeOverlaysHref,
  panelOf,
  plansHref,
  settingsHref,
  toHash,
  type PanelKey,
  type Route,
} from '@/app/routes';

/** How many rows one page of the drawer holds before "Show older". */
const PAGE = 40;

/**
 * The announcements panel's own two query keys.
 *
 * `?panel=` is the precedent: what the drawer is SHOWING belongs in the
 * address, so a filtered view can be linked, reloaded and shared. They live
 * here rather than in `app/routes.ts` only because that file is not this
 * feature's to edit; they belong beside `PANEL_KEYS`, and `closeOverlaysHref`
 * should drop them the way it drops `panel` — until it does, `closeDrawerHref`
 * below is what keeps them from outliving the overlay they describe.
 */
const FILTER_KEYS = { unread: 'unread', category: 'category' } as const;

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
 * The drawer's address with one filter changed.
 *
 * Composed by handing `bellHref` a route whose query already says what we want
 * — it copies the query, drops the other overlays and stamps `bell`/`panel` —
 * rather than assembling a hash here, which is how two spellings of the same
 * address start to drift.
 */
function filterHref(
  route: Route,
  panel: PanelKey,
  next: Partial<Record<'unread' | 'category', string | null>>,
): string {
  const query = { ...route.query };
  for (const [key, value] of Object.entries(next)) {
    if (value == null || value === '') delete query[key];
    else query[key] = value;
  }
  return bellHref({ ...route, query }, panel);
}

/** Closing takes the filters with it: they describe a panel that is no longer open. */
function closeDrawerHref(route: Route): string {
  const query = { ...route.query };
  delete query[FILTER_KEYS.unread];
  delete query[FILTER_KEYS.category];
  return closeOverlaysHref({ ...route, query });
}

/**
 * The bell drawer — two questions, over whatever page you are on.
 *
 * **Needs you** is the same `GET /api/inbox` rows Now leads with, rendered by
 * the same `InboxRow`, with the same buttons that do the same thing. That is
 * the whole point of the panel: before it, an approval answered on a phone
 * stayed on the laptop's dashboard until a reload, because the drawer and the
 * dashboard were two lists over two queries with two ideas of what an "item"
 * was. One component over one query is what makes acting from either surface
 * update the other in the same tick.
 *
 * **Announcements** is the log of what the console has SAID. It is the surface
 * the whole notification store exists for: a phone asleep and no tab open used
 * to mean the event had simply never happened. Every row says not only what was
 * announced but what became of it, because a silent delivery failure is exactly
 * the thing that is invisible otherwise.
 *
 * Keeping them as two panels rather than one merged list is deliberate. "This
 * still needs you" and "this was announced at 04:12 and reached no device" are
 * different questions with different lifetimes — an inbox row disappears when
 * the thing it is about is fixed, an announcement never does — and the 2.x page
 * that answered both at once is the page nobody read.
 *
 * `?bell=1` is the open state, like `?k=` and `?help=`, so a push can deep-link
 * straight into it and a reload does not lose it; `?panel=` picks the half, and
 * `?unread=`/`?category=` narrow the announcements.
 *
 * ## One scroller, and the bulk bar is not in it
 *
 * The panel is a flex column three rows deep — filters, list, bulk bar — of
 * which only the middle scrolls. Every part of that is a fix: the drawer could
 * not be scrolled at all while two nested `overflow-y-auto` boxes fought over a
 * height neither had, and the bulk bar sat in flow BELOW the list, which on a
 * hundred-row inbox put it a hundred rows past the fold. An operator who cannot
 * reach a control has the same experience as one for whom it was never built.
 */
export function NotificationsDrawer({ route }: { route: Route }) {
  const navigate = useNavigate();
  const phone = usePhone();
  const open = route.query[OVERLAY_KEYS.bell] != null;
  // Needs-you first by default: the drawer is opened by a bell with a count on
  // it, and the count is of things still waiting. `#/notifications` — the
  // retired announcements page — asks for its own panel by name.
  const panel = panelOf(route) ?? PANEL_KEYS.inbox;

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) navigate(closeDrawerHref(route));
      }}
    >
      {/* Right on a desktop — it is a list beside the page, not over it. Bottom
          on a phone, where a right-hand drawer is a full-screen modal that has
          not admitted it and where the thumb is at the other end of the device.

          `bodyClassName`, not `className`: the sheet's body is the box with the
          padding on it, and a `p-0` aimed at the sheet was a no-op for as long
          as this drawer has existed.

          `overflow-y-hidden` hands the scrolling DOWN. The body is the sheet's
          own scroller by default, and a scroller with a scroller inside it is
          the shape this drawer was stuck in: two boxes, each believing the
          other was handling the overflow, and a list that would not move. Here
          the body is a flex column that scrolls nothing, and exactly one box
          below it does. It must be the `-y-` spelling: `overflow-hidden` is a
          different tailwind-merge group and would leave `overflow-y-auto`
          standing beside it. */}
      <SheetContent
        side={phone ? 'bottom' : 'right'}
        title="Inbox"
        showTitle
        bodyClassName="flex flex-col overflow-y-hidden p-0"
      >
        {open && (
          <DrawerPanels
            route={route}
            panel={panel}
            onPanel={(next) => navigate(filterHref(route, next, { unread: null, category: null }))}
            onFilters={(next) => navigate(filterHref(route, panel, next))}
            onOpen={(url) => navigate(toHash(url))}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

/**
 * The two panels and the switch between them.
 *
 * Mounted one at a time on purpose: each holds a paged server query, and a
 * closed panel has no business keeping one warm.
 *
 * The switch is `shrink-0` and the panel takes the rest. The panel is what owns
 * the scrolling, because only the panel knows which of its own rows must stay
 * out of it.
 */
function DrawerPanels({
  route,
  panel,
  onPanel,
  onFilters,
  onOpen,
}: {
  route: Route;
  panel: PanelKey;
  onPanel: (panel: PanelKey) => void;
  onFilters: (next: Partial<Record<'unread' | 'category', string | null>>) => void;
  onOpen: (url: string) => void;
}) {
  // Unconditional, unlike every other run-endpoint read in the app: the shell
  // only mounts this drawer once `/api/state` has answered, so the stale-server
  // guard has already been applied one level up — and `useAttentionInbox` does
  // not retry, so a console too old for the endpoint costs exactly one 404.
  const inbox = useAttentionInbox();
  const waiting = needsYouCount(inbox.data?.items);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-rule px-3 py-2">
        <Button
          size="sm"
          variant={panel === PANEL_KEYS.inbox ? 'action' : 'ghost'}
          aria-pressed={panel === PANEL_KEYS.inbox}
          onClick={() => onPanel(PANEL_KEYS.inbox)}
        >
          Needs you
          <CountBadge count={waiting} tone="accent" label="waiting on you" />
        </Button>
        <Button
          size="sm"
          variant={panel === PANEL_KEYS.announcements ? 'action' : 'ghost'}
          aria-pressed={panel === PANEL_KEYS.announcements}
          onClick={() => onPanel(PANEL_KEYS.announcements)}
        >
          Announcements
        </Button>
      </div>
      {panel === PANEL_KEYS.inbox ? (
        <NeedsYouPanel items={inbox.data?.items} loading={inbox.isPending} onOpen={onOpen} />
      ) : (
        <DrawerBody filters={filtersOf(route)} onFilters={onFilters} onOpen={onOpen} />
      )}
    </div>
  );
}

/** The scrolling middle of a panel — the ONE box in the drawer that scrolls. */
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

/**
 * The needs-you rows, in the drawer.
 *
 * `compact` drops the plan/phase line each row carries on Now — in a 380px
 * drawer that line is what pushes the buttons below the fold, and the row's
 * own title already names the plan.
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
  const { perform, ack, ackMany, busy, bulkBusy } = useInboxActions();
  const rows = useMemo(() => items ?? [], [items]);
  const pick = useSelection(rows);
  const picked = useMemo(() => rows.filter((item) => pick.has(item.id)), [rows, pick]);
  const unacked = useMemo(() => rows.filter((item) => !item.ack), [rows]);

  if (loading && !items) {
    return (
      <PanelScroller className="flex flex-col gap-2 p-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-20" />
        ))}
      </PanelScroller>
    );
  }

  if (!items?.length) {
    return (
      <PanelScroller className="p-3">
        <Empty
          title="Nothing needs you"
          body="Errands, permission cards, gates and sign-ins all arrive here — and on Now, which is the same list."
          action={
            <Button asChild>
              <a href={plansHref()}>Open Plans</a>
            </Button>
          }
        />
      </PanelScroller>
    );
  }

  // The dedicated section: live asks — sessions stopped dead until a person
  // answers — above everything else that waits. Headed only when both halves
  // exist; a heading over a list of everything says nothing.
  const { asks, rest } = partitionAsks(items);
  const row = (item: InboxItem) => (
    <InboxRow
      key={item.id}
      item={item}
      perform={perform}
      ack={ack}
      checked={pick.has(item.id)}
      onCheck={(extend) => pick.toggle(item.id, extend)}
      {...(busy ? { busy } : {})}
      compact
      onOpen={onOpen}
    />
  );

  return (
    <>
      <PanelScroller>
        {!asks.length || !rest.length ? (
          <ul className="flex flex-col gap-2 p-3">{items.map(row)}</ul>
        ) : (
          <div className="flex flex-col gap-1 p-3">
            <div className="flex items-center gap-2 px-1 pb-1">
              <SectionHeading as="h3">Sessions asking you</SectionHeading>
              <CountBadge count={asks.length} tone="accent" label="asks" />
            </div>
            <ul className="flex flex-col gap-2">{asks.map(row)}</ul>
            <SectionHeading as="h3" className="px-1 pt-3 pb-1">
              Also waiting
            </SectionHeading>
            <ul className="flex flex-col gap-2">{rest.map(row)}</ul>
          </div>
        )}
      </PanelScroller>
      {/*
       * The same bar the Now page has, over the same list — docked, so it is on
       * screen from the moment there is anything to act on rather than a
       * hundred rows down. The drawer offers no remedies, only acknowledgement:
       * a two-inch panel is not where anyone should be starting four recovery
       * sessions.
       */}
      <SelectionBar
        dock
        count={pick.count}
        state={pick.state}
        onToggleAll={pick.toggleAll}
        onClear={pick.clear}
        verbs={[]}
        onVerb={() => {}}
        onAcknowledge={() => {
          const undo = pick.ids;
          ackMany(picked, () => pick.restore(undo));
          pick.clear();
        }}
        allAcked={picked.length > 0 && picked.every((item) => item.ack)}
        busy={bulkBusy}
      >
        <ConfirmButton
          size="sm"
          variant="action"
          disabled={bulkBusy || unacked.length === 0}
          busy={bulkBusy}
          title={`Acknowledge ${plural(unacked.length, 'thing')}?`}
          description="Acknowledged is seen, not cleared: nothing is fixed and every one of them comes back if what it is about changes. The undo runs for ten seconds."
          confirmLabel="Acknowledge them"
          details={
            // Named, not counted, for the same reason the bulk remedy on Now
            // names its asks: a number tells you how many, the list tells you
            // whether they are the ones you meant.
            <ul className="flex max-h-40 flex-col gap-0.5 overflow-y-auto text-2xs text-ink-muted">
              {unacked.map((item) => (
                <li key={item.id}>· {item.title}</li>
              ))}
            </ul>
          }
          // No `restore` on undo, unlike the selection's: nothing was ticked to
          // put back, and re-ticking a hundred rows an operator never picked is
          // not an undo, it is a second thing to clear.
          onConfirm={() => ackMany(unacked)}
        >
          Acknowledge all
        </ConfirmButton>
      </SelectionBar>
    </>
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
  const delivered = item.delivery ?? [];
  if (!delivered.length) return { text: 'no device', failed: false };
  // `quiet` is a device inside its own quiet hours: nothing was attempted, on
  // purpose. It is neither a delivery nor a failure, and reading it as a
  // failure would paint every night red.
  const quiet = delivered.filter((d) => d.outcome === 'quiet').length;
  const failed = delivered.filter((d) => d.outcome !== 'sent' && d.outcome !== 'quiet');
  if (failed.length) return { text: `${failed.length}/${delivered.length} not delivered`, failed: true };
  if (quiet === delivered.length) return { text: 'held by quiet hours', failed: false };
  if (quiet) return { text: `sent to ${delivered.length - quiet} · ${quiet} quiet`, failed: false };
  return { text: `sent to ${delivered.length}`, failed: false };
}

/**
 * The category chips a filter row offers: what has actually been announced,
 * named as the push catalogue names it, in the catalogue's own graded order.
 *
 * `seen` rather than "what is in `data.items`" because a page filtered to one
 * category holds exactly one, and a filter row that collapses to the chip you
 * just pressed can only un-press itself. The catalogue is not the answer
 * either: fourteen chips for a console that has ever raised three is a row
 * nobody reads.
 *
 * Order is the catalogue's, which is graded by what stops work — so the chips
 * do not reshuffle as records arrive. An id the catalogue does not carry (an
 * older server, a category since retired) sorts to the end under its own name
 * rather than disappearing.
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
 * The announcements list. Split out so the drawer mounts it only while that
 * panel is showing — it is a paged server query, and a panel nobody is looking
 * at has no business holding one.
 *
 * Three rows: the filters, the list, the bulk bar. Only the list scrolls, so
 * neither the thing that narrows the list nor the thing that acts on it can be
 * scrolled off the screen.
 */
export function DrawerBody({
  filters,
  onFilters,
  onOpen,
}: {
  filters: DrawerFilters;
  onFilters: (next: Partial<Record<'unread' | 'category', string | null>>) => void;
  onOpen: (url: string) => void;
}) {
  const [limit, setLimit] = useState(PAGE);
  // A page cursor is not an address: narrowing the list starts it again from
  // the top rather than holding four pages of a filter nobody asked for.
  useEffect(() => setLimit(PAGE), [filters.unread, filters.category]);

  const { data, isPending } = useInbox({
    ...(filters.unread ? { unread: true } : {}),
    ...(filters.category ? { category: filters.category } : {}),
    limit,
  });
  /*
   * The announcements half already had bulk verbs on the SERVER —
   * `markNotificationsRead(ids)` has taken a list since it shipped — and no way
   * on screen to name a list. "Mark all read" was the only bulk gesture, which
   * is all-or-nothing on a hundred and eight records.
   */
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
   * One write, six verbs. Each caller supplies the call; what is shared is that
   * a failure is said out loud and the list is re-read either way — including
   * on failure, which is the case where re-reading matters most (a record
   * cleared in another tab answers 404 here, and the phantom row has to go).
   *
   * `/api/state` rides in the bundle because the bell's own count lives there:
   * marking the last unread read has to take the badge down, not merely empty
   * the list underneath it.
   */
  const act = useApiMutation<() => Promise<unknown>>({
    fn: (call) => call(),
    invalidates: keys.afterAnnouncement(),
  });

  const open = useApiMutation<NotificationRecord, string>({
    fn: async (item) => {
      if (!item.read) await api.markNotificationsRead([item.id]);
      return item.url;
    },
    invalidates: keys.afterAnnouncement(),
    // The URL is whatever `routeFor` built on the server — never assembled
    // here. `toHash` normalises the `/#/…` form a push payload carries.
    onDone: (url) => onOpen(url),
  });

  if (isPending && !data) {
    return (
      <PanelScroller className="flex flex-col gap-2 p-3">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-16" />
        ))}
      </PanelScroller>
    );
  }

  if (!data) return null;

  const groups = groupByDay(data.items);
  const nothingCanArrive = data.devices === 0 && !data.outOfBand?.configured;
  const busy = act.isPending;

  return (
    <>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-rule px-3 py-2">
        <Button
          size="sm"
          variant={filters.unread ? 'action' : 'ghost'}
          aria-pressed={filters.unread}
          onClick={() => onFilters({ unread: filters.unread ? null : '1' })}
        >
          Unread only
        </Button>
        {/* Once there is a choice to make — or one to undo. A cold reload into
            `?category=x` sees exactly one category on the page, and a row that
            hid itself there would be a filter with no way out of it. */}
        {(chips.length > 1 || filters.category) && (
          <div role="group" aria-label="Filter by category" className="flex flex-wrap items-center gap-1.5">
            <Button
              size="sm"
              variant={filters.category ? 'ghost' : 'action'}
              aria-pressed={!filters.category}
              onClick={() => onFilters({ category: null })}
            >
              All
            </Button>
            {chips.map((chip) => (
              <Button
                key={chip.id}
                size="sm"
                variant={filters.category === chip.id ? 'action' : 'ghost'}
                aria-pressed={filters.category === chip.id}
                // The chip wears the word each ROW wears, so the connection
                // between the filter and what it keeps needs no explaining; the
                // catalogue's sentence-length label is the hover.
                title={chip.label}
                onClick={() => onFilters({ category: filters.category === chip.id ? null : chip.id })}
              >
                {chip.id}
              </Button>
            ))}
          </div>
        )}
      </div>

      <PanelScroller className="flex flex-col gap-3 p-3">
        {nothingCanArrive && (
          <Banner severity="info">
            <div className="min-w-0">
              <strong>Nothing can reach you out of band yet.</strong> No device is subscribed and no{' '}
              <code>PHASE_CONSOLE_NOTIFY</code> command is set, so these arrive here and nowhere else.{' '}
              <a href={settingsHref('notifications')} className="text-action underline">
                Set a device up
              </a>
              .
            </div>
          </Banner>
        )}

        {!data.items.length ? (
          <Empty
            title={filters.unread || filters.category ? 'Nothing matches' : 'Nothing yet'}
            body={
              filters.unread || filters.category
                ? 'Nothing announced under these filters. Clear them to see the whole log.'
                : 'Approvals, halts, phases landing and plans finishing all arrive here.'
            }
            action={
              filters.unread || filters.category ? (
                <Button onClick={() => onFilters({ unread: null, category: null })}>Clear the filters</Button>
              ) : (
                <Button asChild>
                  <a href={settingsHref('notifications')}>Choose what to be told</a>
                </Button>
              )
            }
          />
        ) : (
          groups.map(([day, items]) => (
            <section key={day}>
              <SectionHeading as="h3" className="mb-1.5">
                {day}
              </SectionHeading>
              <div className="flex flex-col gap-1">
                {items.map((item) => (
                  <DrawerRow
                    key={item.id}
                    item={item}
                    checked={pick.has(item.id)}
                    onCheck={(extend) => pick.toggle(item.id, extend)}
                    onOpen={() => open.mutate(item)}
                    onClear={() => act.mutate(() => api.clearNotifications({ id: item.id }))}
                  />
                ))}
              </div>
            </section>
          ))
        )}

        {data.more && (
          <div>
            <Button onClick={() => setLimit(limit + PAGE)}>Show older</Button>
          </div>
        )}
      </PanelScroller>

      <SelectionBar
        dock
        count={pick.count}
        state={pick.state}
        onToggleAll={pick.toggleAll}
        onClear={pick.clear}
        // Reading is the announcement list's own verb; acknowledging is the
        // other list's. Same bar, different vocabulary, because they are
        // genuinely different acts on genuinely different records.
        verbs={[{ verb: 'read', label: 'Mark read' }]}
        onVerb={() => {
          const ids = pick.ids;
          act.mutate(() => api.markNotificationsRead(ids));
          pick.clear();
        }}
        onAcknowledge={() => {
          const ids = pick.ids;
          act.mutate(async () => {
            for (const id of ids) await api.clearNotifications({ id });
          });
          pick.clear();
        }}
        allAcked
        busy={busy}
      >
        {/* The three whole-list verbs, in the bar the selection verbs use, so
            "for these" and "for all" read as one family rather than as one
            toolbar at the top of the page and another at the bottom. */}
        <Button
          size="sm"
          disabled={busy || data.unread === 0}
          onClick={() => act.mutate(() => api.markNotificationsRead())}
        >
          Mark all read
        </Button>
        <Button
          size="sm"
          disabled={busy || !data.total}
          onClick={() => act.mutate(() => api.clearNotifications('read'))}
        >
          Clear read
        </Button>
        {/* The only irreversible thing in here. It gets a question, and the
            question says how many. */}
        <ConfirmButton
          size="sm"
          variant="danger"
          disabled={busy || !data.total}
          title={`Delete all ${plural(data.total, 'notification')}?`}
          description="This cannot be undone. Delivery history goes with them."
          confirmLabel="Delete them"
          destructive
          onConfirm={() => act.mutate(() => api.clearNotifications('all'))}
        >
          Clear all
        </ConfirmButton>
      </SelectionBar>
    </>
  );
}

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
    <article
      data-checked={checked || undefined}
      className={cn(
        'flex items-stretch gap-1 rounded border bg-surface',
        item.read ? 'border-rule' : 'border-action/45',
        checked && 'bg-surface-raised shadow-[inset_2px_0_0_0_var(--color-queued)]',
      )}
    >
      {onCheck && (
        <span className="flex items-center pl-2">
          <Checkbox
            checked={checked}
            onClick={(event) => onCheck(event.shiftKey)}
            onCheckedChange={() => {}}
            aria-label={`${checked ? 'Unpick' : 'Pick'} ${item.title}`}
          />
        </span>
      )}
      {/* A real link so it can be opened in a background tab; the click also
          marks it read, which a bare href cannot do. */}
      <a
        href={toHash(item.url)}
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
          event.preventDefault();
          onOpen();
        }}
        className="min-w-0 flex-1 px-3 py-2 hover:bg-surface-raised focus-visible:bg-surface-raised"
      >
        <div className="flex items-baseline justify-between gap-2">
          <strong className={`min-w-0 truncate text-sm ${item.read ? 'text-ink-muted' : 'text-ink'}`}>
            {item.title}
          </strong>
          {/* `live={false}`: the log runs to hundreds of rows and none of their
              clocks ever moves — one shared interval would repaint the lot to
              change nothing. */}
          <RelativeTime at={item.at} live={false} className="shrink-0 text-2xs text-ink-faint" />
        </div>
        <p className="mt-0.5 text-sm text-ink-muted">{item.body}</p>
        <div className="mt-1 flex flex-wrap gap-1.5">
          <Chip>{item.category}</Chip>
          {item.resolved ? (
            <Chip title={`Resolved on its own ${item.resolved.reason ? `— ${item.resolved.reason}` : ''}`}>
              resolved itself
            </Chip>
          ) : (
            item.urgent && <Chip tone="warn">urgent</Chip>
          )}
          <Chip
            tone={summary.failed ? 'bad' : delivered.length ? 'ok' : 'neutral'}
            title={
              delivered.length
                ? delivered
                    .map((d) => `${d.label}: ${d.outcome}${d.detail ? ` (${d.detail})` : ''}`)
                    .join('\n')
                : 'No device was subscribed when this was announced'
            }
          >
            {summary.text}
          </Chip>
        </div>
      </a>
      <button
        type="button"
        onClick={onClear}
        aria-label={`Remove “${item.title}”`}
        className="tap-area shrink-0 px-2 text-ink-faint hover:bg-surface-raised hover:text-failed"
      >
        <X className="size-4" aria-hidden />
      </button>
    </article>
  );
}
