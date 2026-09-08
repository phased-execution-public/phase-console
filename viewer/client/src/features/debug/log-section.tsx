/**
 * The log explorer — every source this console writes, on one time axis.
 *
 * Everything on this page is a filter over one endpoint, and every filter is
 * in the URL, because the output of a debugging surface is evidence and
 * evidence has to be quotable.
 *
 * Two rules it holds that a log viewer usually does not:
 *
 *  - **A source that could not be read says so, by name.** "There is no
 *    supervisor log on this machine" and "the supervisor log is empty" look
 *    identical in a list of rows, and they mean opposite things. The strip
 *    under the toolbar is that difference.
 *  - **A cut answer says it was cut.** A page that shows 500 of 4,000 rows and
 *    implies it showed all of them is worse than one that shows nothing.
 */

import { useState } from 'react';
import { Radio, ScrollText } from 'lucide-react';

import type { ViewProps } from '@/app/router';
import { useNavigate } from '@/app/router';
import {
  Badge,
  Banner,
  Button,
  CopyButton,
  DataList,
  Empty,
  Input,
  Inspector,
  MonoId,
  PageError,
  RelativeTime,
  SectionHeading,
  Spinner,
  Switch,
} from '@/components/ui';
import { cn } from '@/lib/cn';
import { DEBUG_LEVELS, DEBUG_SOURCES, type DebugEntry, type DebugLevel, type DebugSource } from '@/lib/api';
import { useDebugIndex } from '@/lib/queries';
import { debugHref, listOf } from './routes';
import { useDebugTail } from './tail';

/** How a level paints. `Badge` has no `warn` — the amber one is `wait`. */
const LEVEL_TONE: Record<DebugLevel, 'neutral' | 'wait' | 'bad'> = {
  info: 'neutral',
  warn: 'wait',
  error: 'bad',
};

/** One line per source, so a filter chip can say what it selects. */
const SOURCE_BLURB: Record<DebugSource, string> = {
  console: 'The console’s own NDJSON log, plus this process’s in-memory ring.',
  supervisor: 'the supervisor’s raw stdout and stderr — where a crash before the logger lands.',
  journal: 'Per-run journals: what each lane did, one event at a time.',
  outcome: 'What an unsupervised session declared about how it ended.',
  ruling: 'What sessions decided, per plan.',
  delivery: 'What happened to each announcement, per device.',
  health: 'The environment doctor’s findings, each with its fix.',
};

function Toggle({
  active,
  label,
  title,
  onClick,
}: {
  active: boolean;
  label: string;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={cn(
        'min-h-(--tap-min) rounded border px-2 py-1 text-xs transition-colors sm:min-h-0',
        active
          ? 'border-rule-strong bg-surface-raised text-ink'
          : 'border-rule text-ink-muted hover:text-ink',
      )}
    >
      {label}
    </button>
  );
}

/**
 * ISO <-> the value a `datetime-local` input takes.
 *
 * The input is local-time and minute-precision with no zone; the wire is ISO
 * with one. Round-tripping through `Date` is what keeps a link somebody pasted
 * from another zone meaning the same instant when they open it.
 */
function toLocalInput(iso: string): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const local = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function fromLocalInput(value: string): string | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function Row({ entry, onOpen }: { entry: DebugEntry; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      // The tap floor, and the wrap that makes it worth having. This row is the
      // ONLY way into a log entry's inspector (the raw record, the Copy
      // button), and at `text-2xs` with `py-1.5` it was a 28px target against a
      // 44px `--tap-min` — the same miss `Toggle` and the Follow label above
      // both avoid with this exact pair. And its three fixed columns (`w-28` +
      // `w-20` + a nowrap Badge + gaps ≈ 261px) left ~59px for the message on a
      // 360px phone, so the row wraps below `sm` and the message takes a line
      // of its own.
      className="flex w-full min-w-0 flex-wrap items-start gap-2 px-2 py-1.5 text-left hover:bg-surface-raised min-h-(--tap-min) sm:min-h-0 sm:flex-nowrap"
    >
      <span className="w-28 shrink-0 font-mono text-2xs text-ink-faint tabular-nums">
        {/* An unplaced row says so rather than borrowing a neighbour's time. */}
        {entry.at ? <RelativeTime at={entry.at} /> : 'undated'}
      </span>
      <Badge tone={LEVEL_TONE[entry.level]} size="sm">
        {entry.level}
      </Badge>
      <span className="w-20 shrink-0 truncate text-2xs text-ink-faint" title={SOURCE_BLURB[entry.source]}>
        {entry.source}
      </span>
      <span className="min-w-0 basis-full sm:flex-1 sm:basis-auto">
        {/* An event name is dotted and space-free (`runner.phase.verify.failed`)
            and had NO break rule at all, so in the narrow column beside it the
            whole token overflowed. `break-all` rather than the `break-words`
            its sibling uses: both break an over-long token, but `break-words`
            only as a last resort once the token has claimed a line of its own,
            which in a column this narrow is the line the message needs. */}
        <span className="font-mono text-2xs break-all text-ink-muted">{entry.event}</span>
        <span className="ml-2 text-xs break-words text-ink">{entry.text}</span>
      </span>
      {entry.slug ? (
        <span className="hidden shrink-0 text-2xs text-ink-faint sm:inline">
          {entry.slug}
          {entry.phase !== undefined ? ` · p${entry.phase}` : ''}
        </span>
      ) : null}
    </button>
  );
}

export default function LogSection({ route }: { route: ViewProps['route'] }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState<DebugEntry | null>(null);

  const sources = listOf(route.query.source, DEBUG_SOURCES);
  const levels = listOf(route.query.level, DEBUG_LEVELS);
  const search = route.query.q ?? '';
  const slug = route.query.slug ?? '';
  const since = route.query.since ?? '';
  const until = route.query.until ?? '';
  const run = route.query.run ?? '';
  // `?phase=` is a number on the wire and a string in the hash. An unparseable
  // one is DROPPED rather than sent as NaN — a URL is user input, and a filter
  // the server cannot read must not narrow the page in some other way.
  const phaseRaw = route.query.phase ?? '';
  const phase = phaseRaw && Number.isFinite(Number(phaseRaw)) ? Number(phaseRaw) : undefined;
  const follow = route.query.follow === '1';

  // Every key the server parses. These were read from the URL and then not
  // sent for one round, which is worse than not offering them: the module
  // header sells `?until=` as the quotable permalink and the truncation banner
  // below tells the reader to add `?since=`. A diagnostics page must not print
  // a remedy that does nothing.
  const params = {
    ...(sources.length ? { source: sources } : {}),
    ...(levels.length ? { level: levels } : {}),
    ...(search ? { q: search } : {}),
    ...(slug ? { slug } : {}),
    ...(since ? { since } : {}),
    ...(until ? { until } : {}),
    ...(run ? { run } : {}),
    ...(phase !== undefined ? { phase } : {}),
  };

  const { data, isPending, error, refetch } = useDebugIndex(params);
  const tail = useDebugTail(params, follow);

  // Carries EVERY key forward, not the five the toolbar happens to draw:
  // rebuilding the href from a subset made a chip click delete a `?since=` the
  // reader had typed, which reads as the filter having been ignored.
  const go = (next: Record<string, string | number | readonly string[] | undefined>) =>
    navigate(
      debugHref('logs', {
        source: sources,
        level: levels,
        q: search,
        slug,
        since,
        until,
        run,
        phase: phaseRaw,
        follow: follow ? '1' : undefined,
        ...next,
      }),
    );

  const toggle = <T extends string>(list: T[], value: T): T[] =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

  if (isPending)
    return (
      <div className="grid place-items-center py-16">
        <Spinner />
      </div>
    );
  if (error) return <PageError error={error} retry={() => void refetch()} />;
  if (!data) return null;

  // Followed rows sit ON TOP of the fetched page rather than replacing it: the
  // page is the history the reader asked for, and the tail is what has
  // happened since. Concatenating is only correct because both are newest-first.
  const rows = follow ? [...tail.entries, ...data.entries] : data.entries;
  // `!available` alone. Requiring a note too meant a source with none was
  // simply not mentioned — and two of the seven shipped without one, so
  // `#/debug?source=ruling` with no directory open drew an empty list under
  // the words "every source this console can read was searched".
  const unavailable = data.sources.filter((s) => !s.available);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={search}
            placeholder="Search the text and the event name"
            aria-label="Search logs"
            className="min-w-48 flex-1"
            onChange={(event) => go({ q: event.target.value })}
          />
          <label className="flex min-h-(--tap-min) items-center gap-2 text-xs text-ink-muted sm:min-h-0">
            <Switch checked={follow} onCheckedChange={(on) => go({ follow: on ? '1' : undefined })} />
            <Radio size={13} aria-hidden className={follow ? 'text-action' : 'text-ink-faint'} />
            Follow
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <SectionHeading as="span" size="band">
            Source
          </SectionHeading>
          {DEBUG_SOURCES.map((source) => (
            <Toggle
              key={source}
              label={source}
              title={SOURCE_BLURB[source]}
              active={sources.includes(source)}
              onClick={() => go({ source: toggle(sources, source) })}
            />
          ))}
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-2xs text-ink-faint uppercase">
            Since
            <Input
              type="datetime-local"
              value={toLocalInput(since)}
              aria-label="Show rows at or after"
              className="w-52"
              onChange={(event) => go({ since: fromLocalInput(event.target.value) })}
            />
          </label>
          <label className="flex flex-col gap-1 text-2xs text-ink-faint uppercase">
            Until
            <Input
              type="datetime-local"
              value={toLocalInput(until)}
              aria-label="Show rows at or before"
              className="w-52"
              onChange={(event) => go({ until: fromLocalInput(event.target.value) })}
            />
          </label>
          {since || until ? (
            <Button size="sm" variant="ghost" onClick={() => go({ since: undefined, until: undefined })}>
              Clear window
            </Button>
          ) : null}
        </div>

        {slug || run || phase !== undefined ? (
          <p className="text-2xs text-ink-faint" data-testid="scope-note">
            {'Scoped to '}
            {[slug && `plan ${slug}`, run && `run ${run}`, phase !== undefined && `phase ${phase}`]
              .filter(Boolean)
              .join(' · ')}
            {'. '}
            <a
              className="text-action underline"
              href={debugHref('logs', { source: sources, level: levels, q: search })}
            >
              Drop the scope
            </a>
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-1.5">
          <SectionHeading as="span" size="band">
            Level
          </SectionHeading>
          {DEBUG_LEVELS.map((level) => (
            <Toggle
              key={level}
              label={level}
              title={`Show only ${level} rows`}
              active={levels.includes(level)}
              onClick={() => go({ level: toggle(levels, level) })}
            />
          ))}
          {sources.length ||
          levels.length ||
          search ||
          since ||
          until ||
          slug ||
          run ||
          phase !== undefined ? (
            <Button size="sm" variant="ghost" onClick={() => navigate(debugHref('logs'))}>
              Clear filters
            </Button>
          ) : null}
        </div>
      </div>

      {follow && tail.status !== 'live' ? (
        <Banner severity={tail.status === 'error' ? 'error' : 'info'}>
          {tail.status === 'error'
            ? 'The follow stream closed. The rows below are the last read; turn Follow off and on to reconnect.'
            : 'Connecting the follow stream. Rows below are the last read.'}
        </Banner>
      ) : null}

      {follow && tail.behind ? (
        <Banner severity="warn" data-testid="tail-gap">
          A frame arrived full, so rows between it and the one before it were dropped. Narrow the filters, or
          read the window above, to see them.
        </Banner>
      ) : null}

      {data.truncated ? (
        <Banner severity="warn" data-testid="logs-truncated">
          More rows matched than are shown. Narrow by source, level or text — or add <code>?since=</code> to
          the URL for a window.
        </Banner>
      ) : null}

      {unavailable.length ? (
        <div className="rounded border border-rule bg-surface px-3 py-2" data-testid="sources-unavailable">
          <SectionHeading as="h3" size="band">
            Not readable here
          </SectionHeading>
          <ul className="mt-1 flex flex-col gap-1 text-xs text-ink-muted">
            {unavailable.map((source) => (
              <li key={source.source}>
                <span className="font-mono text-2xs text-ink">{source.source}</span>
                {' — '}
                {source.note ?? 'this console did not say why.'}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {rows.length === 0 ? (
        <Empty
          icon={<ScrollText size={20} aria-hidden />}
          title="Nothing matched"
          body={
            unavailable.length
              ? `Of the ${DEBUG_SOURCES.length} sources, ${unavailable.length} could not be read at all — see above. The rest had nothing matching.`
              : 'Every source this console can read was searched. Widen the filters, or clear them to see the whole log.'
          }
        />
      ) : (
        <DataList
          items={rows}
          role="log"
          label="Console logs"
          keyOf={(entry, index) => `${entry.at}|${entry.source}|${entry.event}|${index}`}
          estimateRowHeight={34}
          rowClassName="border-b border-rule/60"
          renderRow={(entry) => <Row entry={entry} onOpen={() => setOpen(entry)} />}
        />
      )}

      <p className="text-2xs text-ink-faint">
        {rows.length}
        {' rows · sources: '}
        {data.sources
          .filter((s) => s.available)
          .map((s) => `${s.source} (${s.count})`)
          .join(', ') || 'none could be read'}
        {data.slugs.length ? ` · plans: ${data.slugs.join(', ')}` : ''}
      </p>

      <Inspector
        open={Boolean(open)}
        onOpenChange={(next) => {
          if (!next) setOpen(null);
        }}
        title={open?.event ?? ''}
        description={open?.text}
        meta={
          open ? (
            <div className="flex flex-wrap items-center gap-2 text-2xs text-ink-faint">
              <Badge tone={LEVEL_TONE[open.level]} size="sm">
                {open.level}
              </Badge>
              <span>{open.source}</span>
              {open.at ? <RelativeTime at={open.at} /> : <span>undated</span>}
              {open.slug ? <MonoId id={open.slug} /> : null}
              {open.runId ? <MonoId id={open.runId} /> : null}
              {open.phase !== undefined ? <span>{`phase ${open.phase}`}</span> : null}
              <CopyButton text={() => JSON.stringify(open, null, 2)} label="Copy row" />
            </div>
          ) : undefined
        }
        raw={<pre className="overflow-x-auto font-mono text-2xs">{JSON.stringify(open, null, 2)}</pre>}
      >
        {/* The redaction is stated where the record is read, not only in the
            docs: a reader comparing this against the file on disk must know
            why a 40-character token reads `[redacted]` here and not there. */}
        <p className="text-2xs text-ink-faint">
          Secret-shaped runs and the operator’s home path are masked on the way out of the server, in this
          record as well as in the bundle.
        </p>
      </Inspector>
    </div>
  );
}
