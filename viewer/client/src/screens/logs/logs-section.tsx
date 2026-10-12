/**
 * Logs ▸ Logs — every source this console writes, on one time axis.
 *
 * ```
 * [Search the text and the event name…]  Filter 2   Follow  500 rows ▾   ⋯   Everything
 * 812 rows: console 600, journal 200, outcome 12.
 * Log level  Info, as configured.   › Change the level
 * 14:02:11  ● Warning  console   runner.phase.verify.failed   The verify step failed for phase 7
 * 14:01:58  ● Info     journal   phase.boarded                Phase 7 boarded on a0de94f27bb4
 * ```
 *
 * One line per row: the clock, the level as a dot and a word, the source, the
 * event's name and what it said; a row opens in the panel, where its plan, its
 * run and its trace are links. Everything adds the trace, the plan and the
 * phase to each line. Every filter is in the address (`routes.ts`).
 *
 * Two rules a log viewer usually does not hold. A source that could not be
 * read says so, by name — "there is no supervisor log on this machine" and
 * "the supervisor log is empty" look alike in a list and mean opposite things.
 * And a cut answer says it was cut, with the remedy as a press.
 *
 * Follow opens the page's own tail (`tail.ts`): followed rows sit on top of
 * the rows read, both newest first, so what happened since is above what was
 * asked for.
 */

import { Fragment, useId, useMemo, type ReactNode } from 'react';
import { DEBUG_LEVELS, DEBUG_SOURCES, type DebugEntry, type DebugIndexParams } from '@/data/api';
import { useDebugIndex } from '@/data/logs';
import { cn } from '@/lib/cn';
import { clockTime, plural } from '@/lib/format';
import { navigate, type Route } from '@/shell/routes';
import { Banner, Button, Empty, Input, Label, Skeleton, copy, useEverything } from '@/ui';
import { Checkbox } from '@/ui/checkbox';
import { DataList } from '@/ui/data-list';
import { NativeSelect } from '@/ui/native-select';
import { OpsStatus } from '@/ui/status';
import { Toolbar, type ToolbarVerb } from '@/ui/toolbar';
import { LEVEL_WORD, LOG_SOURCE_BLURB, entryKey, inspectEntry } from './inspector';
import { LevelCard } from './level';
import { listOf, logsSectionHref, phaseOf } from './routes';
import { useLogTail, type TailState } from './tail';

/** What the index answers without `?limit=` (`DEFAULT_LIMIT`, `server/debug/sources.ts`). */
export const DEFAULT_ROWS = 500;
/** The steps the Rows control offers, up to the server's own ceiling. */
export const ROW_LIMITS: readonly number[] = [100, DEFAULT_ROWS, 2000, 5000];

const CHOICE =
  'flex min-h-8 min-w-0 cursor-pointer items-start gap-2 text-body text-ink [@media(hover:none)]:min-h-(--tap-min)';

/**
 * ISO <-> what a `datetime-local` field takes: local time to the minute, no
 * zone. Round-tripping through `Date` keeps a link pasted from another zone
 * meaning the same instant.
 */
export function toLocalInput(iso: string): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  return new Date(ms - new Date(ms).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function fromLocalInput(value: string): string | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/** A line's clock: the time today, the day and the time before today. */
function clockOf(at: string, now = new Date()): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return at;
  if (d.toDateString() === now.toDateString()) return clockTime(d.getTime());
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${clockTime(d.getTime()).slice(0, 5)}`;
}

/** Everything the address says about the explorer, read once. */
export function readLogQuery(query: Readonly<Record<string, string>>) {
  const sources = listOf(query.source, DEBUG_SOURCES);
  const levels = listOf(query.level, DEBUG_LEVELS);
  const traceRaw = query.trace ?? '';
  // A `?trace=` that is no trace id would narrow the page to nothing, which
  // reads as "this run left no evidence" — the one wrong answer this page can give.
  const trace = /^[0-9a-f]{32}$/.test(traceRaw) ? traceRaw : '';
  const limitRaw = Number(query.limit);
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? limitRaw : undefined;
  const read = {
    sources,
    levels,
    q: query.q ?? '',
    slug: query.slug ?? '',
    run: query.run ?? '',
    phase: phaseOf(query.phase),
    since: query.since ?? '',
    until: query.until ?? '',
    trace,
    limit,
    follow: query.follow === '1',
  };
  // Every key the server parses, and only what was given.
  const params: DebugIndexParams = {
    ...(sources.length ? { source: sources } : {}),
    ...(levels.length ? { level: levels } : {}),
    ...(read.q ? { q: read.q } : {}),
    ...(read.slug ? { slug: read.slug } : {}),
    ...(read.run ? { run: read.run } : {}),
    ...(read.phase !== undefined ? { phase: read.phase } : {}),
    ...(read.since ? { since: read.since } : {}),
    ...(read.until ? { until: read.until } : {}),
    ...(trace ? { trace } : {}),
    ...(limit ? { limit } : {}),
  };
  return { read, params };
}

type LogRead = ReturnType<typeof readLogQuery>['read'];

/** The explorer's address with `next` laid over what the reader already asked for. */
function hrefWith(read: LogRead, next: Partial<Record<keyof LogRead, unknown>>): string {
  const merged = { ...read, ...next } as LogRead;
  return logsSectionHref('logs', {
    q: merged.q,
    source: merged.sources,
    level: merged.levels,
    since: merged.since,
    until: merged.until,
    slug: merged.slug,
    run: merged.run,
    phase: merged.phase,
    trace: merged.trace,
    limit: merged.limit,
    follow: merged.follow ? '1' : undefined,
  });
}

const toggled = <T extends string>(list: readonly T[], value: T): T[] =>
  list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

/** One line of the log. */
function LogLine({ entry, index, everything }: { entry: DebugEntry; index: number; everything: boolean }) {
  return (
    <Button
      variant="ghost"
      onClick={() => inspectEntry(entry, index)}
      className={cn(
        'h-auto w-full shrink justify-start rounded-none px-2 py-1.5 text-start font-normal whitespace-normal text-ink',
        'grid grid-cols-[auto_auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-0.5',
        'sm:grid-cols-[4.75rem_6.5rem_5.5rem_minmax(0,1fr)]',
      )}
      data-testid="log-line"
      data-level={entry.level}
    >
      <span
        className="tnum text-meta text-ink-muted"
        title={entry.at ? new Date(entry.at).toLocaleString() : undefined}
      >
        {entry.at ? <time dateTime={entry.at}>{clockOf(entry.at)}</time> : 'undated'}
      </span>
      <OpsStatus vocab="health" word={LEVEL_WORD[entry.level]} />
      <span className="truncate text-meta text-ink-muted" title={LOG_SOURCE_BLURB[entry.source]}>
        {entry.source}
      </span>
      <span className="col-span-full min-w-0 sm:col-span-1">
        {/* A dotted name has nothing to wrap at, so it may break anywhere. */}
        <span className="me-2 font-mono text-meta wrap-anywhere text-ink-muted">{entry.event}</span>
        <span className="text-body break-words">{entry.text}</span>
        {everything && (entry.slug || entry.traceId) ? (
          <span className="mt-0.5 flex flex-wrap gap-x-3 text-meta text-ink-muted">
            {entry.slug ? (
              <span>
                {entry.slug}
                {entry.phase !== undefined ? `, phase ${entry.phase}` : ''}
              </span>
            ) : null}
            {entry.runId ? <span className="font-mono">{entry.runId}</span> : null}
            {entry.traceId ? <span className="font-mono">trace {entry.traceId.slice(0, 12)}</span> : null}
          </span>
        ) : null}
      </span>
    </Button>
  );
}

/** The filter slot's panel: the sources, the levels and the window. */
function FilterPanel({ read }: { read: LogRead }) {
  const id = useId();
  const go = (next: Partial<Record<keyof LogRead, unknown>>) => navigate(hrefWith(read, next));
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <fieldset className="flex min-w-0 flex-col gap-1">
        <legend className="mb-1 text-meta text-ink-muted">Source</legend>
        {DEBUG_SOURCES.map((source) => (
          <label key={source} className={CHOICE}>
            <Checkbox
              className="mt-1"
              checked={read.sources.includes(source)}
              onCheckedChange={() => go({ sources: toggled(read.sources, source) })}
            />
            <span className="flex min-w-0 flex-col">
              <span>{source}</span>
              <span className="text-meta text-ink-muted">{LOG_SOURCE_BLURB[source]}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <fieldset className="flex min-w-0 flex-col gap-1">
        <legend className="mb-1 text-meta text-ink-muted">Level</legend>
        {DEBUG_LEVELS.map((level) => (
          <label key={level} className={CHOICE}>
            <Checkbox
              className="mt-1"
              checked={read.levels.includes(level)}
              onCheckedChange={() => go({ levels: toggled(read.levels, level) })}
            />
            <OpsStatus vocab="health" word={LEVEL_WORD[level]} />
          </label>
        ))}
      </fieldset>
      <fieldset className="flex min-w-0 flex-col gap-2">
        <legend className="mb-1 text-meta text-ink-muted">Window</legend>
        <div className="flex min-w-0 flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${id}-since`}>Since</Label>
            <Input
              id={`${id}-since`}
              type="datetime-local"
              value={toLocalInput(read.since)}
              aria-label="Show rows at or after"
              onChange={(event) => go({ since: fromLocalInput(event.target.value) ?? '' })}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${id}-until`}>Until</Label>
            <Input
              id={`${id}-until`}
              type="datetime-local"
              value={toLocalInput(read.until)}
              aria-label="Show rows at or before"
              onChange={(event) => go({ until: fromLocalInput(event.target.value) ?? '' })}
            />
          </div>
          {(read.since || read.until) && (
            <Button size="sm" variant="ghost" onClick={() => go({ since: '', until: '' })}>
              Clear the window
            </Button>
          )}
        </div>
      </fieldset>
    </div>
  );
}

/** Follow, as a press that says whether it is on. The dot breathes while rows arrive. */
function FollowToggle({ read, tail }: { read: LogRead; tail: TailState }) {
  return (
    <Button
      size="sm"
      variant={read.follow ? 'default' : 'ghost'}
      aria-pressed={read.follow}
      onClick={() => navigate(hrefWith(read, { follow: !read.follow }), { replace: true })}
      data-testid="follow"
    >
      <span
        aria-hidden
        className={cn(
          'inline-block size-1.5 rounded-full',
          read.follow ? 'state-running bg-state' : 'bg-ink-faint',
          read.follow && tail.status === 'live' && 'animate-pulse-soft',
        )}
      />
      Follow
    </Button>
  );
}

/** How many rows to read — the server's own steps, and the address's if it named another. */
function RowsSelect({ read }: { read: LogRead }) {
  const limit = read.limit ?? DEFAULT_ROWS;
  return (
    <NativeSelect
      value={String(limit)}
      aria-label="How many rows to read"
      className="w-28"
      onChange={(event) => {
        const next = Number(event.target.value);
        navigate(hrefWith(read, { limit: next === DEFAULT_ROWS ? undefined : next }));
      }}
    >
      {ROW_LIMITS.map((n) => (
        <option key={n} value={n}>
          {`${n.toLocaleString()} rows`}
        </option>
      ))}
      {!ROW_LIMITS.includes(limit) && <option value={limit}>{`${limit.toLocaleString()} rows`}</option>}
    </NativeSelect>
  );
}

/** The line under the bar: what was read, from where, and the scope with its way out. */
function Note({ read, rows, counted }: { read: LogRead; rows: number; counted: ReactNode }) {
  const scope = [
    read.slug && `plan ${read.slug}`,
    read.run && `run ${read.run}`,
    read.phase !== undefined && `phase ${read.phase}`,
    read.trace && `trace ${read.trace.slice(0, 12)}`,
  ].filter(Boolean) as string[];
  return (
    <span className="flex min-w-0 flex-wrap gap-x-3">
      <span>
        {plural(rows, 'row')}
        {counted}
      </span>
      {scope.length ? (
        <span data-testid="scope-note">
          Scoped to {scope.join(', ')}.{' '}
          <a
            className="tap-line whitespace-nowrap text-ink underline decoration-ink-faint underline-offset-2"
            href={hrefWith(read, { slug: '', run: '', phase: undefined, trace: '' })}
          >
            Drop the scope
          </a>
        </span>
      ) : null}
    </span>
  );
}

export default function LogsSection({ route }: { route: Route }) {
  const { read, params } = readLogQuery(route.query);
  const everything = useEverything('logs');
  const index = useDebugIndex(params);
  const tail = useLogTail(params, read.follow);
  const data = index.data;

  // Followed rows on top of the rows read: both newest first.
  const rows = useMemo(
    () => (read.follow ? [...tail.entries, ...(data?.entries ?? [])] : (data?.entries ?? [])),
    [read.follow, tail.entries, data],
  );
  const unavailable = (data?.sources ?? []).filter((s) => !s.available);
  const filtered = Boolean(read.sources.length || read.levels.length || read.q || read.since || read.until);
  const scoped = Boolean(read.slug || read.run || read.phase !== undefined || read.trace);
  const active = [
    read.sources.length > 0,
    read.levels.length > 0,
    Boolean(read.since),
    Boolean(read.until),
  ].filter(Boolean).length;
  const nextLimit = ROW_LIMITS.find((n) => n > (read.limit ?? DEFAULT_ROWS));

  const verbs: ToolbarVerb[] = [
    {
      id: 'clear',
      label: 'Clear every filter',
      onSelect: () => navigate(logsSectionHref('logs')),
      ...(filtered || scoped || read.limit ? {} : { disabled: 'No filter is set.' }),
    },
    { id: 'copy', label: 'Copy the address of this view', onSelect: () => void copy(window.location.href) },
  ];

  const counted = data ? (
    <>
      {': '}
      {data.sources
        .filter((s) => s.available && s.count > 0)
        .map((s) => `${s.source} ${s.count.toLocaleString()}`)
        .join(', ') || 'no source had a row'}
      .
    </>
  ) : null;

  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="logs-explorer">
      <Toolbar
        label="Logs"
        search={{
          value: read.q,
          onChange: (q) => navigate(hrefWith(read, { q }), { replace: true }),
          // Short, like every 7.0 bar's ("Find a plan"): the box is 14rem on a
          // desk, and a longer hint was cut mid-word at every width.
          placeholder: 'Find a line',
          label: 'Search logs',
        }}
        filter={{
          active,
          value: active ? undefined : 'Every source',
          panel: <FilterPanel read={read} />,
        }}
        view={{
          label: 'View',
          value: read.follow ? 'Following' : `${(read.limit ?? DEFAULT_ROWS).toLocaleString()} rows`,
          active: (read.follow ? 1 : 0) + (read.limit ? 1 : 0),
          inline: (
            <span className="flex items-center gap-2">
              <FollowToggle read={read} tail={tail} />
              <RowsSelect read={read} />
            </span>
          ),
          panel: (
            <div className="flex min-w-0 flex-col gap-3">
              <div className="flex items-center gap-3">
                <FollowToggle read={read} tail={tail} />
                <span className="text-meta text-ink-muted">New rows arrive at the top.</span>
              </div>
              <RowsSelect read={read} />
            </div>
          ),
        }}
        more={verbs}
        everything={everything}
        note={data ? <Note read={read} rows={rows.length} counted={counted} /> : undefined}
      />

      <LevelCard />

      {read.follow && tail.status !== 'live' && tail.status !== 'off' && (
        <Banner severity={tail.status === 'error' ? 'error' : 'info'}>
          {tail.status === 'error'
            ? 'The follow stream closed. The rows below are the last read; turn Follow off and on to reconnect.'
            : 'Connecting the follow stream. The rows below are the last read.'}
        </Banner>
      )}
      {read.follow && tail.behind && (
        <Banner severity="warn" data-testid="tail-gap">
          A frame arrived full, so rows between it and the one before it were dropped. Narrow the filters, or
          read a window, to see them.
        </Banner>
      )}
      {data?.truncated && (
        <Banner
          severity="warn"
          data-testid="logs-truncated"
          action={
            nextLimit ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => navigate(hrefWith(read, { limit: nextLimit }))}
              >
                {`Read ${nextLimit.toLocaleString()} rows`}
              </Button>
            ) : undefined
          }
        >
          More rows matched than are shown. Narrow by source, level or text, read more rows, or set a window.
        </Banner>
      )}
      {unavailable.length > 0 && (
        // A term and its reason: the server's sentence starts with its own
        // capital ("No console.out.log on this machine"), so it stands under
        // the source's name rather than after a comma. A path in it breaks
        // anywhere — on a phone it is wider than the screen.
        <div className="flex min-w-0 flex-col gap-1 text-meta" data-testid="sources-unavailable">
          <span className="text-ink-muted">Not readable here</span>
          <dl className="grid min-w-0 gap-x-4 gap-y-1 sm:grid-cols-[auto_minmax(0,1fr)]">
            {unavailable.map((source) => (
              <Fragment key={source.source}>
                <dt className="text-ink">{source.source}</dt>
                <dd className="min-w-0 text-ink-muted [overflow-wrap:anywhere]">
                  {source.note ?? 'This console did not say why.'}
                </dd>
              </Fragment>
            ))}
          </dl>
        </div>
      )}

      {index.error ? (
        <Banner
          severity="error"
          action={
            <Button size="sm" variant="ghost" onClick={() => void index.refetch()}>
              Try again
            </Button>
          }
        >
          The logs could not be read: {index.error.message}
        </Banner>
      ) : !data ? (
        <div className="flex flex-col gap-2" aria-busy="true" aria-label="Reading the logs">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-6" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <Empty
          title={
            unavailable.length
              ? `Nothing matched in the sources that could be read (${DEBUG_SOURCES.length - unavailable.length} of ${DEBUG_SOURCES.length}).`
              : 'Nothing matched.'
          }
          action={
            filtered || scoped ? (
              <Button size="sm" onClick={() => navigate(logsSectionHref('logs'))}>
                Clear every filter
              </Button>
            ) : undefined
          }
        />
      ) : (
        <DataList
          items={rows}
          role="log"
          label="Console logs"
          keyOf={entryKey}
          estimateRowHeight={34}
          rowClassName="border-b border-rule"
          renderRow={(entry, i) => <LogLine entry={entry} index={i} everything={everything.on} />}
        />
      )}
    </div>
  );
}
