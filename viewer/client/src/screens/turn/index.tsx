/**
 * `#/turn` — Your turn (7.0, quiet-console phase 8; control-tower phase 137,
 * #214, §Architecture 19).
 *
 * ```
 * Two things wait on you; one unblocks phase 4.      ← the heading IS the headline
 * Round 14, read at 12:00. It last changed at 11:50.  ← the lead
 * [search]  Filter (2)                 ⋯  Everything
 * Do now 2 ─────────────────── Grant every low-risk ask (1)
 *   ┌ the item card: its state, its title, why only you, the guide on the line, ONE move ┐
 * Needs one detail from you 1 ───────────────────────
 * Coming up 1 ───  Being checked 1 ───  Done 3 (folded) ───  Handled by the AI 4 (folded)
 * ```
 *
 * Every act only a person can do, on one page under one name: the headline
 * the console composed is the page's one sentence, the round is its clock, and
 * six sections follow in a fixed order, one card per item (`cards/item-card`,
 * lent the page's parts: the permission card, the owner's requests, the
 * check's outcome). The page decides nothing about an item — `GET /api/turn`
 * folded and grouped them — and owns only the reading: the filters and the
 * search, kept in the address so a narrowed view is a link; Inspect, which
 * shows an item's explain view in the panel; *Withdraw*; *Export* and *Print*;
 * where a push lands (`#/turn/<id>` opens that item and scrolls to it); and
 * the hold — an item pressed here leaves the list only on the server's `turn`
 * event (#270), never on the press.
 */

import './turn.css';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { HUMAN_STEP_SETTLED_STATES } from '@shared/human-step-model.js';
import { errorWords } from '@/cards/human-step-card';
import { useInboxActions } from '@/cards/inbox-row';
import type { HumanStepRecord } from '@/data/human-steps';
import { keys } from '@/data/keys';
import { replayWords } from '@/data/press';
import { useHumanSteps, useTurn, withdrawItem, type TurnAnswer, type TurnItem } from '@/data/turn';
import { scrollIntoScroller } from '@/lib/scroll';
import { useNavigate } from '@/shell/router';
import { repoHref, toHash, type Route } from '@/shell/routes';
import { Button, Empty, Page, Skeleton, toast, useEverything } from '@/ui';
import { ConfirmButton } from '@/ui/confirm';
import { NativeSelect } from '@/ui/native-select';
import { Toolbar, type ToolbarVerb } from '@/ui/toolbar';
import { downloadMarkdown, turnMarkdown } from './export';
import { GrantEveryLowRisk, useSettling } from './grants';
import { TurnSections } from './groups';
import { inspectItem } from './inspector';
import {
  FACET_KEYS,
  FILTER_LABEL,
  activeFacets,
  facetsOf,
  filtering,
  filtersHref,
  filtersOf,
  historyOf,
  itemOf,
  openSections,
  sectionsOf,
  type TurnFacet,
  type TurnSection,
} from './page-model';
import { TurnItemCard, turnParts } from './parts';

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

function clockTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const at = new Date(iso);
  return Number.isFinite(at.getTime())
    ? at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : iso;
}

/** The round, its time, and when it last changed the turn — the page's lead. */
function RoundLine({ round }: { round: TurnAnswer['round'] }) {
  return (
    <span data-testid="turn-round">
      {/* Round 0 is a console no round has changed the turn on yet: no number to give. */}
      {round.n > 0 ? `Round ${round.n}, read` : 'Read'} at{' '}
      <time dateTime={round.at}>{clockTime(round.at)}</time>.
      {round.changedAt ? (
        <>
          {' '}
          It last changed at <time dateTime={round.changedAt}>{clockTime(round.changedAt)}</time>.
        </>
      ) : null}
    </span>
  );
}

/** One of the five selects of the Filter slot. */
function FilterSelect({
  name,
  value,
  facets,
  onChange,
}: {
  name: (typeof FACET_KEYS)[number];
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

export default function TurnPage({ route }: { route: Route }) {
  const client = useQueryClient();
  const go = useNavigate();
  const focus = route.segments[1] ?? null;
  const filters = useMemo(() => filtersOf(route.query), [route.query]);
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
  const sections = useMemo(() => (answer ? sectionsOf(answer, filters) : []), [answer, filters]);
  const facets = useMemo(() => facetsOf(answer), [answer]);
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

  // A push opens one item: the page scrolls to it once (its section unfolds itself).
  const focusedId = focused?.item;
  useEffect(() => {
    if (!focusedId) return;
    const frame = window.requestAnimationFrame(() => {
      const el = document.getElementById(`turn-item-${focusedId}`);
      if (el) scrollIntoScroller(el, 'start');
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
    go(filtersHref(route, { plan: '', run: '', kind: '', why: '', risk: '', q: '' }), { replace: true });

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

  const asideOf = (section: TurnSection) =>
    section.id === 'now' ? (
      <GrantEveryLowRisk items={[...answer.groups.now, ...answer.groups.decide]} onSettled={settle} />
    ) : null;

  return (
    <Page
      title={<span data-testid="turn-headline">{answer.headline}</span>}
      lead={<RoundLine round={answer.round} />}
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
              {FACET_KEYS.map((name) => (
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
        sections={sections}
        filters={filters}
        everything={everything.on}
        earlier={earlier}
        handledSince={answer.counts.handled}
        settling={settling}
        focusedSection={focused?.group ?? null}
        asideOf={asideOf}
        renderItem={renderItem}
      />
    </Page>
  );
}
