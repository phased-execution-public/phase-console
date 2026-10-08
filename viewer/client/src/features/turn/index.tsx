/**
 * `#/turn` — Your turn (control-tower phase 137, #214, §Architecture 19).
 *
 * Every act only a person can do, on one page under one name, lighting Runs:
 * the round that last read the turn and its one-sentence headline, then six
 * sections in a fixed order — *Do now*, *Needs one detail from you*, *Coming
 * up*, *Being checked*, *Done*, *Handled by the AI* — and in each, one card
 * per item (`item-card.tsx`) that explains the task exactly.
 *
 * The page decides nothing about an item: `GET /api/turn` folded every inbox
 * row that asks a person for an act into one item and grouped it. What the
 * page owns is the reading:
 *
 *   - the filters (plan, run, kind, reason, risk) and the search, kept in the
 *     address, so a narrowed view is a link (`page-model.ts`);
 *   - *Export* — one Markdown document of the open items with their guides —
 *     and *Print*, the same on paper (`turn.css`'s print sheet);
 *   - where a push lands: `#/turn/<id>` opens that item and scrolls to it.
 *
 * *Done* holds the day's settled items, and under them the ledger's older
 * ones; it and the handled log are folded with their counts, because what is
 * over is the record, not the work. The page replaced `#/approve`, phase 42's
 * phone surface, which lands here in one hop.
 */

import './turn.css';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Download, Printer, SlidersHorizontal } from 'lucide-react';

import { useNavigate, useRoute } from '@/app/router';
import { toHash } from '@/app/routes';
import { Page } from '@/components/page';
import { Button, Disclosure, Empty, Input, PageError, Skeleton, fieldSurface } from '@/components/ui';
import { OpsBadge } from '@/components/ui/status/ops-badge';
import { stamp, useHumanSteps } from '@/components/human-step-card';
import { useInboxActions } from '@/components/inbox-row';
import { turnApi, type TurnAnswer } from '@/lib/api/turn';
import type { HumanStepRecord } from '@/lib/api';
import { keys } from '@/lib/queries';
import { scrollIntoScroller } from '@/lib/scroll';
import { cn } from '@/lib/cn';
import { HandledList } from './handled';
import { ItemCard } from './item-card';
import { GrantEveryLowRisk } from './permission-card';
import { downloadMarkdown, turnMarkdown } from './export';
import {
  type FILTER_KEYS,
  facetsOf,
  filtering,
  filtersHref,
  filtersOf,
  historyOf,
  itemOf,
  sectionsOf,
  type Facet,
  type Section,
  type SectionId,
  type TurnFilters,
} from './page-model';

/** The person's last look, for the handled count — kept in this browser. */
const SEEN_KEY = 'turn:seen';

function readSeen(): string | null {
  try {
    return window.localStorage.getItem(SEEN_KEY);
  } catch {
    return null;
  }
}

/** What an empty section says — an invitation where there is one, a fact where there is not. */
const EMPTY_WORDS: Readonly<Record<SectionId, string>> = Object.freeze({
  now: 'Nothing to do now.',
  decide: 'No decision waits on you.',
  upcoming: 'Nothing is coming up.',
  checking: 'Nothing is being checked.',
  done: 'Nothing settled today.',
  handled: 'The AI handled nothing on its own in this window.',
});

/** The filters a select offers, named as a person reads them. */
const FILTER_LABEL: Readonly<Record<Exclude<(typeof FILTER_KEYS)[number], 'q'>, string>> = Object.freeze({
  plan: 'Plan',
  run: 'Run',
  kind: 'Kind',
  why: 'Reason',
  risk: 'Risk',
});

function clockTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const at = new Date(iso);
  return Number.isFinite(at.getTime())
    ? at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : iso;
}

/** The round, its time, and when it last changed the turn. */
function RoundLine({ round }: { round: TurnAnswer['round'] }) {
  return (
    <span data-testid="turn-round">
      {/* Round 0 is a console no round has changed the turn on yet: no number to give. */}
      {round.n > 0 ? `Round ${round.n}, read` : 'Read'} at{' '}
      <time dateTime={round.at}>{clockTime(round.at)}</time>
      {round.changedAt ? (
        <>
          {' '}
          — it last changed at <time dateTime={round.changedAt}>{clockTime(round.changedAt)}</time>
        </>
      ) : null}
      .
    </span>
  );
}

function FilterSelect({
  name,
  value,
  facets,
  onChange,
}: {
  name: Exclude<(typeof FILTER_KEYS)[number], 'q'>;
  value: string | undefined;
  facets: Facet[];
  onChange: (value: string) => void;
}) {
  if (!facets.length && !value) return null;
  return (
    <label className="flex min-w-0 flex-col gap-1 text-2xs text-ink-muted">
      {FILTER_LABEL[name]}
      <select
        data-testid={`turn-filter-${name}`}
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value)}
        className={cn(fieldSurface, 'w-full rounded px-2 text-xs text-ink md:w-auto md:max-w-48')}
      >
        <option value="">Any</option>
        {facets.map((facet) => (
          <option key={facet.value} value={facet.value}>
            {facet.label} ({facet.count})
          </option>
        ))}
        {value && !facets.some((facet) => facet.value === value) && <option value={value}>{value}</option>}
      </select>
    </label>
  );
}

/** One section: its heading and count, then its cards — or its one empty sentence. */
function SectionBlock({
  section,
  filters,
  children,
}: {
  section: Section;
  filters: TurnFilters;
  children: ReactNode;
}) {
  const hidden = section.total - section.count;
  const headingId = `turn-section-${section.id}`;
  return (
    <section
      aria-labelledby={headingId}
      data-testid="turn-section"
      data-section={section.id}
      className="flex min-w-0 flex-col gap-2.5"
    >
      <h2 id={headingId} className="flex items-baseline gap-2 text-sm font-semibold text-ink">
        {section.label}
        <span className="text-xs font-normal text-ink-muted tabular-nums" data-testid="turn-section-count">
          {section.count}
        </span>
      </h2>
      {children}
      {hidden > 0 && filtering(filters) && (
        <p className="text-2xs text-ink-muted">{hidden} more hidden by the filters.</p>
      )}
    </section>
  );
}

/** The ledger's older settled steps — Done's history. */
function History({ steps }: { steps: HumanStepRecord[] }) {
  if (!steps.length) return null;
  return (
    <div className="flex flex-col gap-1.5" data-testid="turn-done-history">
      <h3 className="text-xs font-medium text-ink">Earlier</h3>
      <ol className="flex list-none flex-col gap-1 p-0">
        {steps.map((step) => (
          <li
            key={step.id}
            data-testid="turn-done-earlier"
            className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs"
          >
            <OpsBadge vocab="step" word={step.state} />
            <span className="min-w-0 break-words text-ink">{step.title}</span>
            <span className="text-2xs text-ink-muted">
              {step.slug}
              {step.phase ? `, phase ${step.phase}` : ''}, {stamp(step.at)}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export default function TurnPage() {
  const route = useRoute();
  const go = useNavigate();
  const focus = route.segments[1] ?? null;
  const filters = useMemo(() => filtersOf(route.query), [route.query]);
  const [seen] = useState(readSeen);
  const turn = useQuery({
    queryKey: keys.turn(seen),
    queryFn: () => turnApi.read(seen),
    placeholderData: keepPreviousData,
    retry: false,
  });
  const ledger = useHumanSteps();
  const { perform, busy } = useInboxActions();
  const answer = turn.data;
  const records = useMemo(
    () => new Map((ledger.data?.steps ?? []).map((step) => [step.id, step] as const)),
    [ledger.data],
  );
  const sections = useMemo(() => (answer ? sectionsOf(answer, filters) : []), [answer, filters]);
  const facets = useMemo(() => facetsOf(answer), [answer]);
  const earlier = useMemo(() => historyOf(ledger.data?.steps, answer), [ledger.data, answer]);
  const focused = itemOf(answer, focus ?? undefined);
  const [query, setQuery] = useState(filters.q ?? '');
  const [doneOpen, setDoneOpen] = useState(false);
  const active = (['plan', 'run', 'kind', 'why', 'risk'] as const).filter((key) => filters[key]).length;
  const [filtersOpen, setFiltersOpen] = useState(active > 0);
  const [handledOpen, setHandledOpen] = useState(false);

  // The next visit counts what the AI handled since this one.
  useEffect(() => {
    if (!answer?.round.at) return;
    try {
      window.localStorage.setItem(SEEN_KEY, answer.round.at);
    } catch {
      /* private mode: the count falls back to the last day */
    }
  }, [answer?.round.at]);

  // A push opens one item: the section holding it unfolds, and the page scrolls to it once.
  const focusedId = focused?.item;
  useEffect(() => {
    if (!focusedId) return;
    if (focused?.group === 'done') setDoneOpen(true);
    const frame = window.requestAnimationFrame(() => {
      const el = document.getElementById(`turn-item-${focusedId}`);
      if (el) scrollIntoScroller(el, 'start');
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusedId, focused?.group]);

  // The search follows the address (back, a link), and the address follows the search.
  useEffect(() => setQuery(filters.q ?? ''), [filters.q]);
  useEffect(() => {
    if ((filters.q ?? '') === query.trim()) return;
    const timer = window.setTimeout(() => go(filtersHref(route, { q: query }), { replace: true }), 250);
    return () => window.clearTimeout(timer);
  }, [query, filters.q, route, go]);

  if (turn.isLoading) {
    return (
      <Page title="Your turn">
        <div className="flex flex-col gap-3" data-turn-page>
          <Skeleton className="h-6 w-2/3" />
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
        </div>
      </Page>
    );
  }

  if (turn.isError || !answer) {
    return (
      <Page title="Your turn">
        <div data-turn-page>
          <PageError error={turn.error} retry={() => void turn.refetch()} />
        </div>
      </Page>
    );
  }

  const nothing = answer.counts.total === 0 && !answer.handled.length;
  const card = (item: (typeof sections)[number]['items'][number], folded: boolean) => (
    <li key={item.item} className="min-w-0">
      <ItemCard
        item={item}
        record={item.record === 'ledger' ? records.get(item.item) : undefined}
        perform={perform}
        busy={busy}
        focused={focused?.item === item.item}
        folded={folded}
      />
    </li>
  );
  const issues = answer.issues && answer.issues.count > 0 ? toHash(answer.issues.href) : null;

  return (
    <Page title="Your turn" subtitle={<RoundLine round={answer.round} />}>
      <div data-turn-page className="flex min-w-0 flex-col gap-6">
        <p data-testid="turn-headline" className="max-w-prose text-lg leading-snug text-ink">
          {answer.headline}
        </p>

        <GrantEveryLowRisk items={[...answer.groups.now, ...answer.groups.decide]} />

        {focus && !focused && (
          <p data-testid="turn-item-gone" className="text-xs text-ink-muted">
            That item is no longer waiting on you — it was done, withdrawn or handed back.
          </p>
        )}

        {/* On a phone the search and the three buttons are one line, and the five
            filters fold behind *Filters* — the items, not the controls, are the
            first screen. From 768 up every control stands in one row. */}
        <div
          role="search"
          aria-label="Narrow the turn"
          data-print="hide"
          className="flex min-w-0 flex-col gap-2"
        >
          <div className="flex min-w-0 flex-wrap items-end gap-2">
            <label className="flex min-w-40 flex-1 flex-col gap-1 text-2xs text-ink-muted">
              Search
              <Input
                type="search"
                data-testid="turn-search"
                value={query}
                placeholder="A title, a command, a plan"
                onChange={(event) => setQuery(event.target.value)}
                className="h-9 text-xs"
              />
            </label>
            <div className="flex gap-1.5">
              <Button
                size="sm"
                className="md:hidden"
                data-testid="turn-filters-toggle"
                aria-expanded={filtersOpen}
                aria-controls="turn-filters"
                onClick={() => setFiltersOpen((was) => !was)}
              >
                <SlidersHorizontal size={14} aria-hidden />
                Filters{active ? ` (${active})` : ''}
              </Button>
              <Button
                size="sm"
                data-testid="turn-export"
                disabled={!sections.some((section) => section.id !== 'done' && section.items.length)}
                onClick={() =>
                  downloadMarkdown(
                    turnMarkdown(answer, sections, records),
                    `your-turn-${answer.round.at.slice(0, 10)}.md`,
                  )
                }
              >
                <Download size={14} aria-hidden />
                Export
              </Button>
              <Button size="sm" data-testid="turn-print" onClick={() => window.print()}>
                <Printer size={14} aria-hidden />
                Print
              </Button>
            </div>
          </div>
          <div
            id="turn-filters"
            data-testid="turn-filters"
            className={cn(
              filtersOpen ? 'grid' : 'hidden',
              'min-w-0 grid-cols-2 gap-2 md:flex md:flex-wrap md:items-end md:gap-3',
            )}
          >
            {(['plan', 'run', 'kind', 'why', 'risk'] as const).map((name) => (
              <FilterSelect
                key={name}
                name={name}
                value={filters[name]}
                facets={facets[name]}
                onChange={(value) => go(filtersHref(route, { [name]: value }), { replace: true })}
              />
            ))}
          </div>
        </div>

        {issues && (
          <p data-testid="turn-issues" className="text-xs text-ink-muted" data-print="hide">
            {answer.issues!.count === 1
              ? 'One issue draft waits'
              : `${answer.issues!.count} issue drafts wait`}{' '}
            for you on{' '}
            <a href={issues} className="tap-row text-ink underline underline-offset-2">
              Repo ▸ Issues
            </a>
            .
          </p>
        )}

        {nothing ? (
          <Empty
            title="Nothing is waiting on you"
            body="When a run needs an act only a person can do, it is listed here with the whole of what to do."
          />
        ) : null}

        {sections.map((section) => {
          if (section.id === 'handled') {
            return (
              <SectionBlock key={section.id} section={section} filters={filters}>
                {section.handled?.length ? (
                  <Disclosure
                    label={`What the AI handled${answer.counts.handled ? `, ${answer.counts.handled} since you last looked` : ''}`}
                    openLabel="Fold it"
                    count={section.count}
                    open={handledOpen}
                    onOpenChange={setHandledOpen}
                  >
                    <div className="pt-2">
                      <HandledList rows={section.handled} />
                    </div>
                  </Disclosure>
                ) : (
                  <p className="text-xs text-ink-muted">{EMPTY_WORDS.handled}</p>
                )}
              </SectionBlock>
            );
          }
          if (section.id === 'done') {
            return (
              <SectionBlock key={section.id} section={section} filters={filters}>
                {section.items.length || earlier.length ? (
                  <Disclosure
                    label="What was settled"
                    openLabel="Fold it"
                    count={section.count}
                    open={doneOpen}
                    onOpenChange={setDoneOpen}
                  >
                    <div className="flex flex-col gap-3 pt-2">
                      {section.items.length > 0 && (
                        <ul className="flex list-none flex-col gap-2 p-0">
                          {section.items.map((item) => card(item, true))}
                        </ul>
                      )}
                      <History steps={earlier} />
                    </div>
                  </Disclosure>
                ) : (
                  <p className="text-xs text-ink-muted">{EMPTY_WORDS.done}</p>
                )}
              </SectionBlock>
            );
          }
          return (
            <SectionBlock key={section.id} section={section} filters={filters}>
              {section.items.length ? (
                <ul className="flex list-none flex-col gap-3 p-0">
                  {section.items.map((item) => card(item, section.id === 'upcoming'))}
                </ul>
              ) : (
                <p className="text-xs text-ink-muted">{EMPTY_WORDS[section.id]}</p>
              )}
            </SectionBlock>
          );
        })}
      </div>
    </Page>
  );
}
