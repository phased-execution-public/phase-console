/**
 * `#/turn` — Your turn (7.0, quiet-console phase 8; control-tower phase 137,
 * #214; the board in 7.0's grammar since turn-by-turn phase 9; a page a
 * person works FROM since one-pool phase 14, #377 #366).
 *
 * ```
 * 1 to do now · 5 coming up · 6 done today                     ← the heading IS the headline
 * 3 to do   1 checking   2 passed today                       ← the strip
 * Open 6   Done 11   Handled by the AI 50   All               ← the tabs (`?tab=`)
 * [search]  Filter (2)  Group  Sort  View        ⋯  Everything
 * Status  [To do 3] [Checking 1]   Plan [one-pool 4] …         ← the chips, on a desk
 * Approve 1 ──────────────────────────────
 * ☐ NOW  Approval  Approve the push of pe/x     x  Phase 4  To do  Due in 2 h
 * Nothing to do now, to decide or being checked.
 * ```
 *
 * Every act only a person can do, on one page under one name. The address is
 * the page's whole state: `#/turn[/<id>]?tab=open|done|handled|all
 * &view=list|board|cards|timeline&group=asked|plan|type|deadline|status
 * &sort=oldest|newest|deadline` and the filters (`status`, `time`, `plan`,
 * `type`, `to`; `run`, `kind`, `why`, `risk` under Everything; `q`). Each
 * default is no parameter at all. The list (the default) is one line per
 * item; selecting one names it in the address and opens its whole card in
 * the panel (`panel-card.tsx`) — beside the page at 1200 px and up, a sheet
 * below, a page of its own on a phone — and ↑/↓ or j/k move the selection.
 * The board puts the items in columns by the person's status, one lane per
 * group; the timeline places them on one clock; the cards are 7.1's page.
 * Empty groups fold into one line; Done and Handled are tabs of their own.
 *
 * The same body is every plan's *Your turn* view (`#/plan/<slug>/turn`,
 * `screens/plan/`), scoped to that plan: one source, `GET /api/turn`, read
 * through `?plan=`'s rule, and no second model. The page decides nothing about
 * an item — the server folded and grouped them — and an item pressed here
 * leaves the list only on the server's `turn` event (#270), never on the press.
 */

import './turn.css';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { HUMAN_STEP_SETTLED_STATES } from '@shared/human-step-model.js';
import { errorWords } from '@/cards/human-step-card';
import { useInboxActions } from '@/cards/inbox-row';
import type { HumanStepRecord } from '@/data/human-steps';
import { keys } from '@/data/keys';
import { replayWords } from '@/data/press';
import { useHumanSteps, useTurn, withdrawItem, type TurnItem } from '@/data/turn';
import { BP_WIDE } from '@/lib/media';
import { scrollIntoScroller } from '@/lib/scroll';
import { useSelection } from '@/shell/bell/selection';
import { useNavigate } from '@/shell/router';
import { hrefOf, repoHref, toHash, type Route } from '@/shell/routes';
import { SectionNav } from '@/shell/section-nav';
import { Button, Empty, Page, SectionHeading, Skeleton, toast, useEverything } from '@/ui';
import { ConfirmButton } from '@/ui/confirm';
import { NativeSelect } from '@/ui/native-select';
import { RadioGroup, RadioItem } from '@/ui/radio-group';
import { Toolbar, type ToolbarVerb } from '@/ui/toolbar';
import { TurnBulkBar } from './bulk';
import { downloadMarkdown, turnMarkdown } from './export';
import { GrantEveryLowRisk, SettlingRow, useSettling, type Settling } from './grants';
import { TurnSections } from './groups';
import { HandledList } from './handled';
import { EarlierSteps } from './history';
import { inspectItem } from './inspector';
import {
  EMPTY_WORDS,
  FACET_KEYS,
  FILTER_KEYS,
  FILTER_LABEL,
  GROUPINGS,
  MORE_FACET_KEYS,
  SORTS,
  TABS,
  VIEWS,
  activeFacets,
  arrangeValue,
  arrangementOf,
  facetsOf,
  filtersHref,
  filtersOf,
  foldEmpty,
  groupSections,
  historyOf,
  itemOf,
  itemsOf,
  openSections,
  sectionsOf,
  tabCount,
  tabSections,
  type ArrangeKey,
  type Arrangement,
  type FacetKey,
  type TurnFacet,
  type TurnFilters,
  type TurnSection,
} from './page-model';
import { TurnItemCard, turnParts } from './parts';
import { PlansStrip } from './plans-strip';
import { readSeen, writeSeen } from './seen';
import { TurnStrip } from './strip';
import { FilterChips, TurnBoard, TurnList, TurnTimeline, type Selecting } from './readings';

/** Does the panel stand beside the page — the column, at 1200 px and up? */
function panelBeside(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(`(min-width: ${BP_WIDE}px)`).matches;
}

const SETTLED: ReadonlySet<string> = new Set(HUMAN_STEP_SETTLED_STATES);

/** One select of the Filter slot — the phone's way to the filters the chips show on a desk. */
function FilterSelect({
  name,
  value,
  facets,
  onChange,
}: {
  name: FacetKey;
  value: string | undefined;
  facets: TurnFacet[];
  onChange: (value: string) => void;
}) {
  if (!facets.length && !value) return null;
  return (
    <label className="flex min-w-0 flex-col gap-1 text-meta text-ink-muted">
      {FILTER_LABEL[name]}
      <NativeSelect
        data-testid={`turn-filter-${name}`}
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value)}
        className="w-full max-w-none"
      >
        <option value="">Any</option>
        {facets.map((facet) => (
          <option key={facet.value} value={facet.value}>
            {facet.label} ({facet.count})
          </option>
        ))}
        {value && !facets.some((facet) => facet.value === value) && <option value={value}>{value}</option>}
      </NativeSelect>
    </label>
  );
}

/** One of Group, Sort and View: its choices as radios, each with what it does. */
function Choices<V extends string>({
  name,
  value,
  options,
  onChange,
}: {
  name: string;
  value: V;
  options: readonly { id: V; label: string; blurb: string }[];
  onChange: (value: V) => void;
}) {
  return (
    <RadioGroup aria-label={name} value={value} onValueChange={(next) => onChange(next as V)}>
      {options.map((option) => (
        <RadioItem
          key={option.id}
          id={`turn-${name.replace(/\W+/g, '-').toLowerCase()}-${option.id}`}
          value={option.id}
          label={option.label}
          description={option.blurb}
        />
      ))}
    </RadioGroup>
  );
}

/** Where a held item stands: in the section its group (or, regrouped, its key) names. */
function heldIn(settling: readonly Settling[], section: TurnSection): Settling[] {
  return settling.filter((one) =>
    section.id.startsWith('plan:')
      ? `plan:${one.item.slug ?? ''}` === section.id
      : section.id.includes(':')
        ? false
        : one.item.group === section.id,
  );
}

export interface TurnBodyProps {
  route: Route;
  /** The page's own path, without an item: `turn`, or `plan/<slug>/turn` on a plan. */
  base: string;
  /** The item the address names. */
  focus: string | null;
  /** The plan this body is scoped to — a plan's *Your turn* view. */
  plan?: string;
}

/**
 * Your turn's body — the tabs, the toolbar, the chips and the view — drawn by
 * the page (`#/turn`) and by every plan's *Your turn* view, which scopes it.
 */
export function TurnBody({ route, base, focus, plan }: TurnBodyProps) {
  const client = useQueryClient();
  const go = useNavigate();
  const filters: TurnFilters = useMemo(
    () => ({ ...filtersOf(route.query), ...(plan ? { plan } : {}) }),
    [route.query, plan],
  );
  const arrange = useMemo(() => arrangementOf(route.query), [route.query]);
  const [seen] = useState(readSeen);
  const turn = useTurn(true, seen);
  const ledger = useHumanSteps();
  const { perform, busy } = useInboxActions();
  const everything = useEverything('turn');
  const answer = turn.data;
  const { settling, settle } = useSettling(answer);
  const parts = useMemo(() => turnParts(settle), [settle]);
  const records = useMemo(
    () => new Map((ledger.data?.steps ?? []).map((step) => [step.id, step] as const)),
    [ledger.data],
  );
  // The Time filter reads the answer's own clock: a filtered page does not move under a tick.
  const readAt = answer ? Date.parse(answer.round.at) || Date.now() : Date.now();
  const asked = useMemo(
    () => (answer ? sectionsOf(answer, filters, readAt, arrange.sort) : []),
    [answer, filters, readAt, arrange.sort],
  );
  const grouped = useMemo(
    () => groupSections(tabSections(asked, arrange.tab), arrange.group, readAt),
    [asked, arrange.tab, arrange.group, readAt],
  );
  const holding = useMemo(() => new Set<string>(settling.map((one) => one.item.group)), [settling]);
  const { sections: drawn, empty } = useMemo(
    () => (arrange.group === 'asked' ? foldEmpty(grouped, holding) : { sections: grouped, empty: null }),
    [grouped, arrange.group, holding],
  );
  const facets = useMemo(() => facetsOf(answer, readAt), [answer, readAt]);
  const earlier = useMemo(
    () =>
      historyOf(ledger.data?.steps, answer).filter(
        (step) => !plan || (step.waiters ?? []).some((w) => w.slug === plan),
      ),
    [ledger.data, answer, plan],
  );
  const focused = itemOf(answer, focus ?? undefined);
  const [query, setQuery] = useState(filters.q ?? '');
  const [withdrawing, setWithdrawing] = useState<string | null>(null);
  const order = useMemo(() => itemsOf(drawn).map((item) => ({ id: item.item })), [drawn]);
  const pick = useSelection(order);

  // The next visit counts what the AI handled since this one.
  useEffect(() => {
    if (answer?.round.at) writeSeen(answer.round.at);
  }, [answer?.round.at]);

  const itemHref = useCallback(
    (id: string) => hrefOf(`${base}/${encodeURIComponent(id)}`, route.query),
    [base, route.query],
  );
  const cards = arrange.view === 'cards';

  // The address names one item: the list opens its card in the panel — beside
  // the page, else as a sheet, the phone's page for it. The cards view scrolls
  // to its card and opens the panel only where it stands BESIDE the page:
  // below, a sheet would cover the very card the push landed on.
  const focusedId = focused?.item;
  const focusedRef = useRef<{ item: TurnItem; record: HumanStepRecord | undefined } | null>(null);
  focusedRef.current = focused
    ? { item: focused, record: focused.record === 'ledger' ? records.get(focused.item) : undefined }
    : null;
  useEffect(() => {
    if (!focusedId) return;
    const frame = window.requestAnimationFrame(() => {
      if (!focusedRef.current) return;
      if (cards) {
        const el = document.getElementById(`turn-item-${focusedId}`);
        if (el) scrollIntoScroller(el, 'start');
        inspectItem(focusedRef.current, { open: panelBeside() });
      } else {
        inspectItem(focusedRef.current, { open: true, card: true });
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusedId, cards]);

  const selecting: Selecting = useMemo(
    () => ({
      selected: focusedId ?? null,
      onSelect: (item: TurnItem) => {
        if (item.item === focusedId) {
          inspectItem(
            { item, record: item.record === 'ledger' ? records.get(item.item) : undefined },
            { open: true, card: true },
          );
          return;
        }
        go(itemHref(item.item), { replace: true });
      },
    }),
    [focusedId, records, go, itemHref],
  );

  // The search follows the address (back, a link), and the address follows the search.
  useEffect(() => setQuery(filters.q ?? ''), [filters.q]);
  useEffect(() => {
    if ((filters.q ?? '') === query.trim()) return;
    const timer = window.setTimeout(() => go(filtersHref(route, { q: query }), { replace: true }), 250);
    return () => window.clearTimeout(timer);
  }, [query, filters.q, route, go]);

  const withdraw = useCallback(
    async (item: TurnItem) => {
      setWithdrawing(item.item);
      try {
        const pressed = await withdrawItem(item.item);
        if (pressed.state === 'asked') {
          settle(
            item,
            'Withdrawal asked of the owner. It leaves this list once the console records the answer.',
          );
          toast(`Asked of the owner: ${replayWords(pressed.request)}.`, 'info', 8000);
        } else {
          settle(item, 'Withdrawn. It leaves this list once the console records it.');
          toast('Withdrawn. The item leaves your turn once the console records it.', 'ok');
        }
      } catch (cause) {
        toast(errorWords(cause), 'warn', 8000);
      } finally {
        setWithdrawing(null);
        void client.invalidateQueries({ queryKey: keys.inbox() });
      }
    },
    [client, settle],
  );

  if (turn.isPending) {
    return (
      <div className="flex flex-col gap-3" aria-busy="true">
        <Skeleton className="h-8" />
        <Skeleton className="h-32" />
        <Skeleton className="h-32" />
      </div>
    );
  }

  if (turn.isError || !answer) {
    return (
      <Empty
        title={`Your turn could not be read: ${turn.error instanceof Error ? turn.error.message : 'no answer'}.`}
        action={
          <Button size="sm" onClick={() => void turn.refetch()}>
            Read it again
          </Button>
        }
      />
    );
  }

  const headsUp = (answer.headsUp ?? []).filter((item) => !plan || item.slug === plan);
  const scopedTotal = itemsOf(asked).length + headsUp.length + asked.find((s) => s.id === 'handled')!.count;
  const nothing = scopedTotal === 0 && !settling.length;
  const open = openSections(asked).some((section) => section.items.length > 0);
  const issues = !plan && answer.issues && answer.issues.count > 0 ? toHash(answer.issues.href) : null;
  const active = activeFacets(filters) - (plan ? 1 : 0);
  const narrowed =
    FILTER_KEYS.some((key) => key !== 'plan' && Boolean(filters[key])) || (!plan && Boolean(filters.plan));
  const shown = tabSections(asked, arrange.tab)
    .filter((s) => s.id !== 'handled')
    .reduce((n, s) => n + s.count, 0);
  const total = tabSections(asked, arrange.tab)
    .filter((s) => s.id !== 'handled')
    .reduce((n, s) => n + s.total, 0);
  const showHeadsUp = headsUp.length > 0 && (arrange.tab === 'open' || arrange.tab === 'all');
  const arrangeTo = <K extends ArrangeKey>(key: K, value: Arrangement[K]) =>
    go(filtersHref(route, { [key]: arrangeValue(key, value) }), { replace: true });
  const label = <T extends { id: string; label: string }>(list: readonly T[], id: string) =>
    list.find((one) => one.id === id)?.label ?? id;
  const setFilter = (name: FacetKey, value: string) =>
    go(filtersHref(route, { [name]: value }), { replace: true });

  const verbs: ToolbarVerb[] = [
    {
      id: 'export',
      label: 'Export as Markdown',
      onSelect: () =>
        downloadMarkdown(
          turnMarkdown(answer, asked, records),
          `your-turn-${answer.round.at.slice(0, 10)}.md`,
        ),
      ...(open ? {} : { disabled: 'Nothing is open to export' }),
    },
    { id: 'print', label: 'Print', onSelect: () => window.print() },
  ];

  const clear = () =>
    go(
      filtersHref(
        route,
        Object.fromEntries(FILTER_KEYS.filter((key) => !(plan && key === 'plan')).map((key) => [key, ''])),
      ),
      { replace: true },
    );

  const renderItem = (item: TurnItem, folded: boolean) => {
    const record: HumanStepRecord | undefined = item.record === 'ledger' ? records.get(item.item) : undefined;
    const state = record?.state ?? item.step?.state ?? item.humanStep?.state ?? 'notified';
    const withdrawable = item.record === 'ledger' && !SETTLED.has(state);
    return (
      <TurnItemCard
        item={item}
        record={record}
        perform={perform}
        busy={busy}
        focused={focused?.item === item.item}
        folded={folded}
        parts={parts}
        onInspect={() => inspectItem({ item, record })}
        moves={
          withdrawable ? (
            <ConfirmButton
              variant="ghost"
              size="sm"
              data-testid="turn-withdraw"
              title="Withdraw this item?"
              description="It comes off your turn and its session is not told why. To say no with a reason the session reads, use Not doing this instead."
              confirmLabel="Withdraw"
              destructive
              busy={withdrawing === item.item}
              onConfirm={() => void withdraw(item)}
            >
              Withdraw
            </ConfirmButton>
          ) : null
        }
      />
    );
  };

  // A permission is an approval since the groups v2: its batch grant sits on *Approve*.
  const asideOf = (section: TurnSection) =>
    section.id === 'approve' ? (
      <GrantEveryLowRisk
        items={[
          ...(answer.groups.approve ?? []),
          ...(answer.groups.now ?? []),
          ...(answer.groups.decide ?? []),
        ]}
        onSettled={settle}
      />
    ) : null;
  const facetKeys: FacetKey[] = [
    ...FACET_KEYS.filter((key) => !(plan && key === 'plan')),
    // The four 7.0 filters stay readable from any address; Everything offers them.
    ...MORE_FACET_KEYS.filter((key) => everything.on || Boolean(filters[key])),
  ];

  // What the list draws after a section's rows: the items held after a press,
  // the handled log, and Done's older history.
  const after = (section: TurnSection): ReactNode => {
    if (section.id === 'handled') {
      return section.handled?.length ? (
        <HandledList rows={section.handled} />
      ) : (
        <p className="text-body text-ink-muted" data-testid="turn-section-empty">
          {EMPTY_WORDS.handled}
        </p>
      );
    }
    const held = heldIn(settling, section);
    return (
      <>
        {held.length > 0 && (
          <ul className="flex list-none flex-col gap-2 p-0">
            {held.map((one) => (
              <li key={`held:${one.item.item}`} className="min-w-0">
                <SettlingRow settling={one} />
              </li>
            ))}
          </ul>
        )}
        {section.id === 'done' && <EarlierSteps steps={earlier} />}
      </>
    );
  };

  const view =
    arrange.tab === 'handled' || arrange.view === 'list' ? (
      <TurnList
        sections={drawn}
        filters={filters}
        empty={empty}
        now={readAt}
        pick={pick}
        selecting={selecting}
        after={after}
        asideOf={asideOf}
      />
    ) : arrange.view === 'board' ? (
      <TurnBoard sections={drawn} group={arrange.group} now={readAt} selecting={selecting} />
    ) : arrange.view === 'timeline' ? (
      <TurnTimeline sections={drawn} now={readAt} selecting={selecting} />
    ) : (
      <TurnSections
        sections={drawn}
        filters={filters}
        everything={everything.on}
        earlier={earlier}
        handledSince={answer.counts.handled}
        settling={settling}
        focusedSection={focused?.group ?? null}
        emptyLine={empty}
        asideOf={asideOf}
        renderItem={renderItem}
      />
    );

  const picked = itemsOf(drawn).filter((item) => pick.has(item.item));

  return (
    <div
      className="flex min-w-0 flex-col gap-4"
      data-testid="turn-page-body"
      data-view={arrange.view}
      data-tab={arrange.tab}
    >
      <SectionNav
        label="Which items"
        current={arrange.tab}
        sections={TABS.map((tab) => ({
          id: tab.id,
          label: tab.label,
          href: filtersHref(route, { tab: arrangeValue('tab', tab.id) }),
          count: tabCount(asked, tab.id, tab.id === 'open' || tab.id === 'all' ? headsUp.length : 0),
        }))}
      />
      <Toolbar
        label="Your turn"
        search={{
          value: query,
          onChange: setQuery,
          // The hint in the words every other search here uses: at 360 the
          // longer list ("A title, a command, a plan") was cut mid-word.
          placeholder: 'Find an item',
          label: 'Search the turn',
        }}
        filter={{
          active,
          panel: (
            <div
              id="turn-filters"
              data-testid="turn-filters"
              className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2"
            >
              {facetKeys.map((name) => (
                <FilterSelect
                  key={name}
                  name={name}
                  value={filters[name]}
                  facets={facets[name]}
                  onChange={(value) => setFilter(name, value)}
                />
              ))}
            </div>
          ),
        }}
        group={{
          value: label(GROUPINGS, arrange.group),
          active: arrange.group === 'asked' ? 0 : 1,
          panel: (
            <Choices
              name="Group your turn"
              value={arrange.group}
              options={GROUPINGS}
              onChange={(value) => arrangeTo('group', value)}
            />
          ),
        }}
        sort={{
          value: label(SORTS, arrange.sort),
          panel: (
            <Choices
              name="Order your turn"
              value={arrange.sort}
              options={SORTS}
              onChange={(value) => arrangeTo('sort', value)}
            />
          ),
        }}
        view={{
          value: label(VIEWS, arrange.view),
          panel: (
            <Choices
              name="Draw your turn"
              value={arrange.view}
              options={VIEWS}
              onChange={(value) => arrangeTo('view', value)}
            />
          ),
        }}
        more={verbs}
        everything={everything}
        note={
          narrowed ? (
            <>
              <span data-testid="turn-narrowed" className="min-w-0">
                Showing {shown} of {total} {total === 1 ? 'item' : 'items'}
                {filters.q ? ` matching “${filters.q}”` : ''}.
              </span>
              <Button size="sm" variant="ghost" onClick={clear}>
                Clear the filters
              </Button>
            </>
          ) : undefined
        }
      />

      <FilterChips facets={facets} filters={filters} hide={plan ? ['plan'] : []} onChange={setFilter} />

      {focus && !focused && !settling.some((one) => one.item.item === focus) && (
        <p data-testid="turn-item-gone" className="max-w-(--measure) text-body text-ink-muted">
          That item is no longer waiting on you. It was done, withdrawn or handed back.
        </p>
      )}

      {issues && (
        <p data-testid="turn-issues" className="text-meta text-ink-muted" data-print="hide">
          {answer.issues!.count === 1 ? 'One issue draft waits' : `${answer.issues!.count} issue drafts wait`}{' '}
          for you on{' '}
          <a href={issues || repoHref('issues')} className="tap-row text-ink underline underline-offset-2">
            Repo ▸ Issues
          </a>
          .
        </p>
      )}

      {nothing ? (
        <Empty
          title={
            plan
              ? 'Nothing in this plan is waiting on you.'
              : 'Nothing is waiting on you. When a run needs an act only a person can do, it is listed here with the whole of what to do.'
          }
        />
      ) : null}

      {pick.count > 0 && arrange.view === 'list' && (
        <TurnBulkBar items={picked} pick={pick} shown={order.length} onSettled={settle} />
      )}

      {!nothing && view}

      {showHeadsUp && (
        <section
          aria-labelledby="turn-section-heads-up"
          data-testid="turn-heads-up"
          className="flex min-w-0 flex-col gap-3 border-t border-rule py-5"
        >
          <SectionHeading id="turn-section-heads-up" count={headsUp.length}>
            Heads-up
          </SectionHeading>
          <ul className="flex list-none flex-col gap-3 p-0">
            {headsUp.map((item) => (
              <li key={item.item} className="min-w-0">
                {renderItem(item, !everything.on && !cards)}
              </li>
            ))}
          </ul>
        </section>
      )}

      {!plan && (arrange.tab === 'open' || arrange.tab === 'all') && (
        <div className="border-t border-rule" data-print="hide">
          <PlansStrip answer={answer} waitingHref={(slug) => filtersHref(route, { plan: slug })} />
        </div>
      )}
    </div>
  );
}

export default function TurnPage({ route }: { route: Route }) {
  const [seen] = useState(readSeen);
  const turn = useTurn(true, seen);
  const answer = turn.data;
  return (
    <Page
      title={answer ? <span data-testid="turn-headline">{answer.headline}</span> : 'Your turn'}
      lead={answer ? <TurnStrip answer={answer} /> : 'Reading your turn'}
      data-turn-page=""
      data-testid="turn-page"
    >
      <TurnBody route={route} base="turn" focus={route.segments[1] ?? null} />
    </Page>
  );
}
