/**
 * Settles — how each run's work reached the trunk, or why it did not (7.0,
 * quiet-console phase 17).
 *
 * The window is drawn, never implied. `GET /api/repo/settles` reads a journal
 * TAIL — by default 25 runs, 500 entries each, because a whole journal can be
 * tens of megabytes — and settling is the last thing a run does, so the tail
 * usually carries it; a lane that landed early in a long run can fall off.
 * The line under the list always says how far the read looked.
 *
 * `?slug=` asks the SERVER for one plan — its own runs' tails, which reach
 * further back for that plan than the all-plans window does — so it is an
 * address, not a filter over what is on screen. The event and source filters
 * are; so is the search. A settle is a record like any other here: the row
 * opens it in the panel with its run id, which 6.2's row never showed.
 */

import { useMemo, useState } from 'react';
import { describeWord } from '@shared/status-model.js';
import type { RepoSettleEvent, RepoSettles, SettleKind } from '@/data/api';
import { useRepoSettles } from '@/data/repo';
import { plural } from '@/lib/format';
import { useInspected } from '@/shell/panel/inspector-host';
import { navigate, type Route } from '@/shell/routes';
import { Button, Empty, Mono, RelativeTime, useEverything } from '@/ui';
import type { Column } from '@/ui/grid/column';
import { Grid } from '@/ui/grid/grid';
import { OpsStatus } from '@/ui/status';
import { Toolbar } from '@/ui/toolbar';
import { inspectSettle, settleInspectKey, useAddressed } from './inspector';
import { SETTLE_BLURB, SOURCE_BLURB, settleKey } from './model';
import { PanelChoices, ReadError, RowsLoading, reopens } from './parts';
import { repoSectionHref } from './routes';

export const SETTLE_COLUMNS: readonly Column<RepoSettleEvent>[] = [
  {
    id: 'run',
    head: 'Run',
    identity: true,
    flex: true,
    card: 'title',
    min: 200,
    priority: 1,
    value: (e) => e.slug,
    cell: (e) => (
      <span className="flex min-w-0 flex-col gap-0.5 py-0.5">
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <span className="min-w-0 wrap-anywhere text-body text-ink">{e.slug}</span>
          {e.phase !== undefined && <span className="tnum text-meta text-ink-muted">P{e.phase}</span>}
        </span>
        {e.detail && <span className="block min-w-0 break-words text-meta text-ink-muted">{e.detail}</span>}
      </span>
    ),
  },
  {
    id: 'kind',
    head: 'Event',
    // `Not supported here` behind its dot is the widest word of the settle row.
    min: 168,
    priority: 1,
    card: 'meta',
    value: (e) => e.kind,
    cell: (e) => <OpsStatus vocab="settle" word={e.kind} title={SETTLE_BLURB[e.kind] ?? e.kind} />,
  },
  {
    id: 'branch',
    head: 'Branch',
    // A run branch, `pe/<slug>-p<N>`, whole in mono — broken mid-word it reads as two names.
    min: 232,
    priority: 3,
    value: (e) => e.branch,
    cell: (e) =>
      e.branch ? (
        <Mono value={e.branch} className="wrap-anywhere" />
      ) : (
        <span className="text-meta text-ink-faint">—</span>
      ),
  },
  {
    id: 'strategy',
    head: 'Strategy',
    min: 112,
    priority: 4,
    value: (e) => e.strategy,
    cell: (e) => <span className="text-meta text-ink-muted">{e.strategy ?? '—'}</span>,
  },
  {
    id: 'via',
    head: 'Source',
    min: 96,
    priority: 4,
    value: (e) => e.via,
    cell: (e) => (
      <span className="text-meta text-ink-muted" data-testid="settle-via" title={SOURCE_BLURB[e.via]}>
        {e.via === 'record' ? 'Record' : 'Journal'}
      </span>
    ),
  },
  {
    id: 'at',
    head: 'When',
    min: 120,
    priority: 2,
    card: 'meta',
    value: (e) => e.at,
    cell: (e) => <RelativeTime at={e.at} live={false} className="text-meta text-ink-muted" />,
  },
  {
    id: 'runId',
    head: 'Run id',
    min: 128,
    everything: true,
    value: (e) => e.runId,
    cell: (e) => <Mono value={e.runId} />,
  },
];

/** The window the history was read through — always drawn. */
export function ScannedNote({ view }: { view: RepoSettles }) {
  return (
    <p className="max-w-(--measure) text-meta text-ink-muted" data-testid="settles-scanned">
      Read from the tail of {plural(view.scanned.runs, 'run journal')}, at most {view.scanned.entriesPerRun}{' '}
      entries each. Settling is the last thing a run does, so the tail usually carries it; a lane that settled
      early in a long run can be missing here.
      {view.truncated && ' The list itself also reached its cap.'}
    </p>
  );
}

const kindLabel = (kind: SettleKind): string => describeWord('settle', kind).label;

/** The Plan choice that asks for no plan — a radio's value has to be a word. */
const EVERY_PLAN = '__every';

export default function SettlesSection({ route }: { route: Route }) {
  const slug = route.query.slug || undefined;
  const openKey = route.query.event || undefined;
  const { data, isPending, error, refetch } = useRepoSettles(slug ? { slug } : {});
  const everything = useEverything('repo-settles');
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<SettleKind | 'any'>('any');
  const [via, setVia] = useState<RepoSettleEvent['via'] | 'any'>('any');

  const all = data?.events;
  const open = useMemo(
    () => (openKey ? all?.find((e) => settleKey(e) === openKey) : undefined),
    [all, openKey],
  );
  useAddressed(open ? settleInspectKey(open) : undefined, open, inspectSettle);
  const inspected = useInspected()?.key;

  const plans = useMemo(
    () => [...new Set([...(slug ? [slug] : []), ...(all ?? []).map((e) => e.slug)])],
    [all, slug],
  );
  const kinds = useMemo(() => {
    const counts = new Map<SettleKind, number>();
    for (const e of all ?? []) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
    return [...counts].map(([id, n]) => ({ id, label: `${kindLabel(id)} ${n}`, blurb: SETTLE_BLURB[id] }));
  }, [all]);

  const q = query.trim().toLowerCase();
  const rows = useMemo(
    () =>
      (all ?? []).filter(
        (e) =>
          (kind === 'any' || e.kind === kind) &&
          (via === 'any' || e.via === via) &&
          (!q ||
            e.slug.toLowerCase().includes(q) ||
            (e.branch ?? '').toLowerCase().includes(q) ||
            (e.detail ?? '').toLowerCase().includes(q) ||
            e.runId.toLowerCase().startsWith(q)),
      ),
    [all, kind, via, q],
  );
  const narrowed = Boolean(q) || kind !== 'any' || via !== 'any';
  const clear = () => {
    setQuery('');
    setKind('any');
    setVia('any');
  };

  const toolbar = (
    <Toolbar
      label="Settles"
      search={{
        value: query,
        onChange: setQuery,
        placeholder: 'Find a settle',
        label: 'Find a settle by plan, branch, detail or run id',
      }}
      filter={{
        active: (slug ? 1 : 0) + (kind === 'any' ? 0 : 1) + (via === 'any' ? 0 : 1),
        ...(slug ? { value: slug } : {}),
        panel: (
          <div className="flex min-w-0 flex-col gap-4">
            <PanelChoices
              name="Plan"
              value={slug ?? EVERY_PLAN}
              options={[
                { id: EVERY_PLAN, label: 'Every plan', blurb: 'The most recent runs of every plan.' },
                ...plans.map((p) => ({ id: p, label: p, blurb: 'This plan’s own runs, read further back.' })),
              ]}
              onChange={(next) =>
                navigate(repoSectionHref('settles', { slug: next === EVERY_PLAN ? undefined : next }))
              }
              testId="settles-plan"
            />
            <PanelChoices
              name="Event"
              value={kind}
              options={[{ id: 'any', label: `Every event ${all?.length ?? 0}` }, ...kinds]}
              onChange={setKind}
            />
            <PanelChoices
              name="Source"
              value={via}
              options={[
                {
                  id: 'any',
                  label: 'Either source',
                  blurb: 'One moment may appear from both: two pieces of evidence.',
                },
                { id: 'record', label: 'Record', blurb: SOURCE_BLURB.record },
                { id: 'journal', label: 'Journal', blurb: SOURCE_BLURB.journal },
              ]}
              onChange={setVia}
            />
          </div>
        ),
      }}
      everything={everything}
      note={
        narrowed && data ? (
          <>
            <span className="tnum" aria-live="polite">
              {rows.length} of {plural(data.events.length, 'settle')} shown.
            </span>
            <Button size="sm" variant="ghost" onClick={clear}>
              Clear the filters
            </Button>
          </>
        ) : slug ? (
          <span>The settles of {slug}.</span>
        ) : undefined
      }
    />
  );

  if (isPending) {
    return (
      <div className="flex min-w-0 flex-col gap-4">
        {toolbar}
        <RowsLoading label="Reading the settles" />
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex min-w-0 flex-col gap-4">
        {toolbar}
        <ReadError error={error} retry={() => void refetch()} />
      </div>
    );
  }
  if (!data) return null;

  const hrefOf = (e: RepoSettleEvent) => repoSectionHref('settles', { slug, event: settleKey(e) });

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {toolbar}
      <Grid
        label="Settle history"
        columns={SETTLE_COLUMNS}
        rows={rows}
        getRowKey={settleKey}
        rowHref={hrefOf}
        rowProps={(e) => ({
          'data-testid': 'settle-row',
          'data-kind': e.kind,
          'data-via': e.via,
          ...(inspected === settleInspectKey(e) ? { 'aria-current': 'true' } : {}),
          ...reopens(hrefOf(e), () => inspectSettle(e)),
        })}
        rowClassName={(e) => (inspected === settleInspectKey(e) ? 'bg-surface-raised' : undefined)}
        toolbar={false}
        everything={everything}
        tableId="repo-settles"
        empty={
          data.events.length ? (
            <Empty
              title="No settle matches the filters."
              action={
                <Button size="sm" onClick={clear}>
                  Clear the filters
                </Button>
              }
            />
          ) : (
            <Empty
              title={
                slug
                  ? `No settle of ${slug} in the window: nothing of it has settled, or it settled further back than the tail this read covers.`
                  : 'No settle in the window: nothing has settled here yet, or every settle happened further back than the tail this read covers.'
              }
              action={
                slug ? (
                  <Button size="sm" asChild>
                    <a href={repoSectionHref('settles')}>Every plan</a>
                  </Button>
                ) : undefined
              }
            />
          )
        }
      />
      <ScannedNote view={data} />
    </div>
  );
}
