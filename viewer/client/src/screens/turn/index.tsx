/**
 * `#/turn` — Your turn (7.0, quiet-console phase 8; control-tower phase 137,
 * #214, §Architecture 19; the board in 7.0's grammar since turn-by-turn phase 9).
 *
 * ```
 * Two need you now — the oldest (Sign gh in) has waited 3 h.   ← the heading IS the headline
 * 3 to do   1 checking   2 passed today                       ← the strip
 * Round 14, read at 12:00. It last changed at 11:50. Next deadline: Sign gh in, in 3 h.
 * [search]  Filter (2)  Group  Sort  View        ⋯  Everything
 * Approve 1 ─────────────────── Grant every low-risk ask (1)
 *   ┌ the item card (cards/item-card): NOW · type · status · title … ONE move ┐
 * Do now 2 ─── Decide 1 ─── Being checked 1 ─── Coming up 1 ─── Done 3 (folded)
 * Handled by the AI 4 (folded) ─── Heads-up 1 ─── Where the plans stand 2
 * ```
 *
 * Every act only a person can do, on one page under one name: the headline
 * the console composed is the page's one sentence, the strip its numbers and
 * its clock, and the groups v2 follow in a fixed order, one card per item
 * (`cards/item-card`, lent the page's parts: the permission card, the owner's
 * requests, the check's outcome). The page decides nothing about an item —
 * `GET /api/turn` folded and grouped them — and owns only the reading: the
 * filters (Status, Time, Plan, Type, Goes to), the search, Group, Sort and
 * View, all kept in the address so a narrowed view is a link; Inspect, which
 * shows an item's explain view in the panel; *Withdraw*; *Export* and
 * *Print*; where a push lands (`#/turn/<id>` focuses that item, scrolls to it
 * and opens the panel on it — a projected item too — where the panel stands
 * beside the page, and below that hands it the record); and the hold — an item
 * pressed here leaves the list only on the server's `turn` event (#270),
 * never on the press.
 */

import './turn.css';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { useNavigate } from '@/shell/router';
import { repoHref, toHash, type Route } from '@/shell/routes';
import { Button, Empty, Page, SectionHeading, Skeleton, toast, useEverything } from '@/ui';
import { ConfirmButton } from '@/ui/confirm';
import { NativeSelect } from '@/ui/native-select';
import { RadioGroup, RadioItem } from '@/ui/radio-group';
import { Toolbar, type ToolbarVerb } from '@/ui/toolbar';
import { downloadMarkdown, turnMarkdown } from './export';
import { GrantEveryLowRisk, useSettling } from './grants';
import { TurnSections } from './groups';
import { inspectItem } from './inspector';
import {
  FACET_KEYS,
  FILTER_KEYS,
  FILTER_LABEL,
  GROUPINGS,
  MORE_FACET_KEYS,
  SORTS,
  VIEWS,
  activeFacets,
  arrangeValue,
  arrangementOf,
  byPlan,
  facetsOf,
  filtering,
  filtersHref,
  filtersOf,
  historyOf,
  itemOf,
  openSections,
  sectionsOf,
  type ArrangeKey,
  type Arrangement,
  type FacetKey,
  type TurnFacet,
  type TurnSection,
} from './page-model';
import { TurnItemCard, turnParts } from './parts';
import { PlansStrip } from './plans-strip';
import { TurnStrip } from './strip';

/** Does the panel stand beside the page — the column, at 1200 px and up? */
function panelBeside(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(`(min-width: ${BP_WIDE}px)`).matches;
}

/** The person's last look, for the handled count — kept in this browser. */
const SEEN_KEY = 'turn:seen';

function readSeen(): string | null {
  try {
    return window.localStorage.getItem(SEEN_KEY);
  } catch {
    return null;
  }
}

const SETTLED: ReadonlySet<string> = new Set(HUMAN_STEP_SETTLED_STATES);

/** One select of the Filter slot. */
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

export default function TurnPage({ route }: { route: Route }) {
  const client = useQueryClient();
  const go = useNavigate();
  const focus = route.segments[1] ?? null;
  const filters = useMemo(() => filtersOf(route.query), [route.query]);
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
  const sections = useMemo(
    () => (answer ? sectionsOf(answer, filters, readAt, arrange.sort) : []),
    [answer, filters, readAt, arrange.sort],
  );
  const shownSections = useMemo(
    () => (arrange.group === 'plan' ? byPlan(sections) : sections),
    [sections, arrange.group],
  );
  const facets = useMemo(() => facetsOf(answer, readAt), [answer, readAt]);
  const earlier = useMemo(() => historyOf(ledger.data?.steps, answer), [ledger.data, answer]);
  const focused = itemOf(answer, focus ?? undefined);
  const [query, setQuery] = useState(filters.q ?? '');
  const [withdrawing, setWithdrawing] = useState<string | null>(null);

  // The next visit counts what the AI handled since this one.
  useEffect(() => {
    if (!answer?.round.at) return;
    try {
      window.localStorage.setItem(SEEN_KEY, answer.round.at);
    } catch {
      /* private mode: the count falls back to the last day */
    }
  }, [answer?.round.at]);

  // A push opens one item: the page scrolls to it once (its section unfolds
  // itself) and opens the panel on it — a ledger item or a projected one.
  const focusedId = focused?.item;
  const focusedRef = useRef<{ item: TurnItem; record: HumanStepRecord | undefined } | null>(null);
  focusedRef.current = focused
    ? { item: focused, record: focused.record === 'ledger' ? records.get(focused.item) : undefined }
    : null;
  useEffect(() => {
    if (!focusedId) return;
    const frame = window.requestAnimationFrame(() => {
      const el = document.getElementById(`turn-item-${focusedId}`);
      if (el) scrollIntoScroller(el, 'start');
      // The panel opens where it stands BESIDE the page (the column, 1200 and
      // up); below, it would be a sheet over the very card the push landed on,
      // so it takes the record and waits for Inspect or ⌘I.
      if (focusedRef.current) inspectItem(focusedRef.current, { open: panelBeside() });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusedId]);

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
      <Page title="Your turn" lead="Reading your turn" data-turn-page="" data-testid="turn-page">
        <div className="flex flex-col gap-3">
          <Skeleton className="h-8" />
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
        </div>
      </Page>
    );
  }

  if (turn.isError || !answer) {
    return (
      <Page title="Your turn" data-turn-page="" data-testid="turn-page">
        <Empty
          title={`Your turn could not be read: ${turn.error instanceof Error ? turn.error.message : 'no answer'}.`}
          action={
            <Button size="sm" onClick={() => void turn.refetch()}>
              Read it again
            </Button>
          }
        />
      </Page>
    );
  }

  const nothing = answer.counts.total === 0 && !answer.handled.length && !settling.length;
  const open = openSections(sections).some((section) => section.items.length > 0);
  const issues = answer.issues && answer.issues.count > 0 ? toHash(answer.issues.href) : null;
  const active = activeFacets(filters);
  const narrowed = filtering(filters);
  const shown = sections.filter((s) => s.id !== 'handled').reduce((n, s) => n + s.count, 0);
  const total = sections.filter((s) => s.id !== 'handled').reduce((n, s) => n + s.total, 0);
  const headsUp = answer.headsUp ?? [];
  const arrangeTo = <K extends ArrangeKey>(key: K, value: Arrangement[K]) =>
    go(filtersHref(route, { [key]: arrangeValue(key, value) }), { replace: true });
  const label = <T extends { id: string; label: string }>(list: readonly T[], id: string) =>
    list.find((one) => one.id === id)?.label ?? id;

  const verbs: ToolbarVerb[] = [
    {
      id: 'export',
      label: 'Export as Markdown',
      onSelect: () =>
        downloadMarkdown(
          turnMarkdown(answer, sections, records),
          `your-turn-${answer.round.at.slice(0, 10)}.md`,
        ),
      ...(open ? {} : { disabled: 'Nothing is open to export' }),
    },
    { id: 'print', label: 'Print', onSelect: () => window.print() },
  ];

  const clear = () =>
    go(filtersHref(route, Object.fromEntries(FILTER_KEYS.map((key) => [key, '']))), { replace: true });

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
    ...FACET_KEYS,
    // The four 7.0 filters stay readable from any address; Everything offers them.
    ...MORE_FACET_KEYS.filter((key) => everything.on || Boolean(filters[key])),
  ];

  return (
    <Page
      title={<span data-testid="turn-headline">{answer.headline}</span>}
      lead={<TurnStrip answer={answer} />}
      data-turn-page=""
      data-testid="turn-page"
    >
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
                  onChange={(value) => go(filtersHref(route, { [name]: value }), { replace: true })}
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
        <Empty title="Nothing is waiting on you. When a run needs an act only a person can do, it is listed here with the whole of what to do." />
      ) : null}

      <TurnSections
        sections={shownSections}
        filters={filters}
        everything={everything.on}
        earlier={earlier}
        handledSince={answer.counts.handled}
        settling={settling}
        focusedSection={focused?.group ?? null}
        compact={arrange.view === 'compact'}
        asideOf={asideOf}
        renderItem={renderItem}
      />

      {headsUp.length > 0 && (
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
                {renderItem(item, !everything.on && arrange.view === 'compact')}
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="border-t border-rule" data-print="hide">
        <PlansStrip answer={answer} waitingHref={(slug) => filtersHref(route, { plan: slug })} />
      </div>
    </Page>
  );
}
