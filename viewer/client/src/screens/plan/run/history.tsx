/**
 * Every run of the plan — the Run view's History reading, `?view=history`
 * (7.0, quiet-console phase 11; the 6.x page's "Earlier runs" table before it).
 *
 * ```
 * Status                 Run                     Started       Phases done   Spent    Copy id
 * ● Running              a1b2c3d4e5f6 this run   2 hours ago   4 of 12       $4.20    [ Copy ]
 * ○ Halted | a newer run 0f9e8d7c6b5a            yesterday     2 of 12       $12.50   [ Copy ]
 *
 * Run 0f9e8d7c6b5a   ○ Halted | a newer run
 * Started yesterday   Ended yesterday   Spent $12.50   Phases done 2 of 12
 * Why it stopped      ▸ Verification  A check failed on phase 2, phase 2
 * P1  Foundations     ○ Done     1 attempt    $1.10
 *     › What it did
 * P2  Surface         ● Failed   3 attempts   $11.40
 *     › What it did  →  its report (what it said, done and left, why slow, the estimate it gave)
 *                       and its session's last events, read for THAT run (`?run=<id>`)
 * ```
 *
 * The 6.x table dropped the run the page was about; this reading is the
 * history, so it lists every run — the current one marked "this run" — and a
 * plan run once still has a history of one. Each run is one line through the
 * grid: its word in context (a run a newer one overtook reads superseded, quiet,
 * as the Runs home reads it), its id, when it started, how far it got against
 * the plan's phases and what it spent; the line is the address of that run
 * opened (`runViewHref(slug, 'history', id)`), and the id is one press from
 * the clipboard.
 *
 * The opened run sits under the list — in place of it on a phone, with the way
 * back — and is brought into view when its top is not on screen, so a press on
 * a row low in a long list never looks like nothing happened. It says its word,
 * id, clocks and spend, why it stopped (the halt's family and sentence — the
 * remedy only for the current run: a past run's stop is history), and its
 * phases, each folding open onto what THAT run's record says the phase did.
 * A past run does not move, so those reads are made once and never polled
 * (`data/runs.ts`).
 */

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { isClosedPlanStatus } from '@shared/plan-vocab.js';
import { describeRun, type RunCtx } from '@shared/status-model.js';
import type {
  ActivityEvent,
  PhaseActivity,
  PhaseRecord,
  PhaseReport,
  PlanDetail,
  RunState,
} from '@/data/api';
import { glanceOf, isLive } from '@/data/lanes';
import { usePhaseActivity, usePhaseReport } from '@/data/runs';
import { clockTime, money, plural } from '@/lib/format';
import { usePhone } from '@/lib/media';
import { scrollIntoScroller, scrollerOf } from '@/lib/scroll';
import { KeyValue, Money, Mono, RelativeTime, Spinner } from '@/ui';
import { CopyButton } from '@/ui/copy-button';
import { Disclosure } from '@/ui/disclosure';
import type { Column } from '@/ui/grid/column';
import { Grid } from '@/ui/grid/grid';
import { FactPart, PhaseStatus, RunStatus } from '@/ui/status';
import { HaltRow } from '@/cards/halt-card';
import { runViewHref } from '@/shell/routes';
import { ACCOUNT_RECOVERY_PARTS } from '@/screens/settings/account-row';

export interface RunHistoryViewProps {
  slug: string;
  detail: PlanDetail;
  /** `GET /api/run/:slug`'s `history`: whole records, newest first — the first is the current run. */
  history: RunState[];
  /** The run the live reading is about — "this run". */
  currentId: string | null;
  /** The route's `?run=<id>`: the run opened under the list. */
  picked: string | null;
}

/** The orders the list offers — newest first, or most spent first. */
type HistorySort = 'started' | 'spent';

const startedAt = (run: RunState): number => {
  const ms = Date.parse(run.createdAt);
  return Number.isFinite(ms) ? ms : 0;
};

const ORDER: Readonly<Record<HistorySort, (a: RunState, b: RunState) => number>> = {
  started: (a, b) => startedAt(b) - startedAt(a),
  spent: (a, b) => (b.spentUsd ?? 0) - (a.spentUsd ?? 0) || startedAt(b) - startedAt(a),
};

/** A run's status member, given the whole record the history carries. */
type RunMarkRun = Parameters<typeof RunStatus>[0]['run'];

/** The run's word in context: the plan closed, or a newer run overtook it — the Runs home's reading. */
function contextOf(run: RunState, newest: string | null, planClosed: boolean): RunCtx {
  return { planClosed, newerRunId: newest && newest !== run.id ? newest : null };
}

export function RunHistoryView({ slug, detail, history, currentId, picked }: RunHistoryViewProps) {
  const phone = usePhone();
  const [sort, setSort] = useState<HistorySort>('started');
  const total = detail.phases.length;
  const newest = history[0]?.id ?? null;
  const planClosed = isClosedPlanStatus(detail.summary.status);
  const opened = picked ? history.find((run) => run.id === picked) : undefined;

  const columns = useMemo(
    () => historyColumns({ total, currentId, ctxOf: (run) => contextOf(run, newest, planClosed) }),
    [total, currentId, newest, planClosed],
  );
  const rows = useMemo(() => [...history].sort(ORDER[sort]), [history, sort]);

  const list = history.length ? (
    <Grid
      columns={columns}
      rows={rows}
      getRowKey={(run) => run.id}
      label="Every run of this plan"
      rowHref={(run) => runViewHref(slug, 'history', run.id)}
      rowClassName={(run) => (run.id === picked ? 'bg-surface-raised' : undefined)}
      rowProps={(run) => ({
        'data-testid': 'history-row',
        'data-run': run.id,
        ...(run.id === picked ? { 'aria-current': 'true' } : {}),
      })}
      activeSort={sort}
      onSort={(id) => setSort(id === 'spent' ? 'spent' : 'started')}
    />
  ) : (
    <p data-testid="history-empty" className="text-body text-ink-muted">
      This plan has not been run yet.
    </p>
  );

  return (
    <section
      data-testid="run-history"
      aria-label="Every run of this plan"
      className="flex min-w-0 flex-col gap-5"
    >
      {phone && opened ? (
        <a
          href={runViewHref(slug, 'history')}
          data-testid="history-back"
          className="inline-flex items-center self-start rounded-sm text-meta text-ink-muted hover:text-ink hover:underline [@media(hover:none)]:min-h-(--tap-min)"
        >
          All {plural(history.length, 'run')} of this plan
        </a>
      ) : (
        list
      )}
      {opened ? (
        <OpenedRun
          slug={slug}
          detail={detail}
          run={opened}
          current={opened.id === currentId}
          ctx={contextOf(opened, newest, planClosed)}
        />
      ) : picked ? (
        <p data-testid="history-unknown" className="text-body text-ink-muted">
          No run of this plan has the id <Mono value={picked} chars={24} />.{' '}
          <a
            href={runViewHref(slug, 'history')}
            className="rounded-sm text-ink underline-offset-2 hover:underline"
          >
            Show every run
          </a>
        </p>
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * The list
 * ------------------------------------------------------------------ */

function historyColumns({
  total,
  currentId,
  ctxOf,
}: {
  total: number;
  currentId: string | null;
  ctxOf: (run: RunState) => RunCtx;
}): Column<RunState>[] {
  return [
    {
      id: 'status',
      head: 'Status',
      priority: 1,
      // "Halted | a newer run" on one line — a superseded run carries its fact.
      min: 184,
      card: 'meta',
      value: (run) => run.status,
      // The note is free text (a superseding run, a reason, a clock), so it
      // wraps on a line of its own; the dot and its word never do.
      cell: (run) => {
        const note = describeRun(run as RunMarkRun, ctxOf(run)).note;
        return (
          <span className="flex min-w-0 flex-col gap-0.5">
            <RunStatus run={run as RunMarkRun} ctx={ctxOf(run)} withNote={false} />
            {note && <FactPart fact={note} />}
          </span>
        );
      },
    },
    {
      id: 'run',
      head: 'Run',
      identity: true,
      flex: true,
      priority: 1,
      min: 176,
      card: 'title',
      value: (run) => run.id,
      // Plain, not the copy control: the identity is the row's link, and a
      // control inside a link is two targets in one. The copy is the action.
      cell: (run) => (
        <span className="inline-flex min-w-0 flex-wrap items-baseline gap-x-2">
          <Mono value={run.id} chars={12} className="text-ink" />
          {run.id === currentId && (
            <span data-testid="history-current" className="text-meta text-ink-muted">
              this run
            </span>
          )}
        </span>
      ),
    },
    {
      id: 'started',
      head: 'Started',
      priority: 2,
      min: 128,
      card: 'meta',
      value: startedAt,
      sort: { id: 'started', dir: 'descending' },
      // A past run never changes: no clock ticking per row.
      cell: (run) => <RelativeTime at={run.createdAt} live={false} />,
    },
    {
      id: 'phases',
      head: 'Phases done',
      priority: 2,
      min: 112,
      value: (run) => glanceOf(run).done,
      cell: (run) => (
        <span className="tnum" title={`Phases this run settled done, of the plan’s ${total}`}>
          {glanceOf(run).done} of {total}
        </span>
      ),
    },
    {
      id: 'spent',
      head: 'Spent',
      priority: 1,
      min: 96,
      align: 'end',
      card: 'meta',
      value: (run) => run.spentUsd ?? 0,
      sort: { id: 'spent', dir: 'descending' },
      cell: (run) => <Money usd={run.spentUsd} against={run.runBudgetUsd} />,
    },
    {
      id: 'copy',
      head: 'Copy id',
      priority: 1,
      min: 96,
      align: 'end',
      card: 'action',
      hideable: false,
      value: () => null,
      cell: (run) => (
        <CopyButton
          text={run.id}
          label="Copy"
          variant="ghost"
          title={`Copy the run id ${run.id}`}
          aria-label={`Copy the id of run ${run.id.slice(0, 12)}`}
        />
      ),
    },
  ];
}

/* ------------------------------------------------------------------ *
 * The run opened
 * ------------------------------------------------------------------ */

/** Room under the fold a heading needs before it counts as on screen. */
const ON_SCREEN_ROOM = 96;

/** Bring an element's top into its scroller once per `key` — only when it is not already where a person can see it. */
function useBroughtIntoView(ref: RefObject<HTMLElement | null>, key: string): void {
  useEffect(() => {
    const element = ref.current;
    const scroller = element ? scrollerOf(element) : null;
    if (!element || !scroller) return;
    const box = scroller.getBoundingClientRect();
    const top = element.getBoundingClientRect().top;
    if (top >= box.top && top <= box.bottom - ON_SCREEN_ROOM) return;
    scrollIntoScroller(element, 'start');
  }, [ref, key]);
}

function OpenedRun({
  slug,
  detail,
  run,
  current,
  ctx,
}: {
  slug: string;
  detail: PlanDetail;
  run: RunState;
  current: boolean;
  ctx: RunCtx;
}) {
  const box = useRef<HTMLElement>(null);
  useBroughtIntoView(box, run.id);
  const records = useMemo(
    () =>
      Object.values(run.phases ?? {})
        .filter((record): record is PhaseRecord => record != null)
        .sort((a, b) => a.phase - b.phase),
    [run.phases],
  );
  const titles = useMemo(() => new Map(detail.phases.map((one) => [one.phase, one.title])), [detail.phases]);
  const live = isLive(run.status);
  // The recommended move is offered only where pressing it can still matter:
  // the current run, stopped. A past run's stop is history.
  const remedies = current && !live;

  return (
    <section
      ref={box}
      data-testid="history-picked"
      data-run={run.id}
      aria-labelledby={`history-picked-${run.id}`}
      className="flex min-w-0 flex-col gap-4 border-t border-rule pt-4"
    >
      <header className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id={`history-picked-${run.id}`} className="text-section font-semibold text-ink">
          Run <Mono value={run.id} chars={12} className="text-section text-ink" />
        </h2>
        <RunStatus run={run as RunMarkRun} ctx={ctx} size="md" />
        {current && <span className="text-meta text-ink-muted">this run</span>}
      </header>

      <KeyValue
        items={[
          ['Run id', <Mono key="id" value={run.id} copyable className="wrap-anywhere" />],
          ['Started', <RelativeTime key="started" at={run.createdAt} live={false} />],
          ['Ended', live ? 'Still going' : <RelativeTime key="ended" at={run.updatedAt} live={false} />],
          ['Spent', <Money key="spent" usd={run.spentUsd} against={run.runBudgetUsd} />],
          ['Phases done', `${glanceOf(run).done} of ${detail.phases.length}`],
          run.halt
            ? [
                'Why it stopped',
                <HaltRow
                  key="halt"
                  run={run}
                  live={!remedies}
                  {...(remedies ? { parts: ACCOUNT_RECOVERY_PARTS } : {})}
                />,
              ]
            : run.finishedReason
              ? ['How it ended', run.finishedReason]
              : null,
        ]}
      />

      {records.length ? (
        <ol aria-label="Phases of this run" className="flex min-w-0 flex-col gap-3">
          {records.map((record) => (
            <PhaseLine
              key={record.phase}
              slug={slug}
              runId={run.id}
              record={record}
              title={titles.get(record.phase)}
            />
          ))}
        </ol>
      ) : (
        <p className="text-body text-ink-muted">This run recorded no phase.</p>
      )}
    </section>
  );
}

function PhaseLine({
  slug,
  runId,
  record,
  title,
}: {
  slug: string;
  runId: string;
  record: PhaseRecord;
  title: string | undefined;
}) {
  return (
    <li data-testid="history-phase" data-phase={record.phase} className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-meta text-ink-muted tnum">P{record.phase}</span>
        <span className="min-w-0 flex-1 basis-40 break-words text-body text-ink">{title}</span>
        <PhaseStatus record={record as Parameters<typeof PhaseStatus>[0]['record']} />
        <span className="text-meta text-ink-muted tnum">{plural(record.attempts ?? 0, 'attempt')}</span>
        <Money
          usd={record.costUsd}
          className="text-meta"
          {...(record.costUnknown
            ? { title: `${money(record.costUsd)} recorded; the spend is known to be incomplete` }
            : {})}
        />
      </div>
      <Disclosure
        label="What it did"
        openLabel="Hide what it did"
        bodyClassName="flex min-w-0 flex-col gap-3 ps-4 pt-2"
      >
        <PhaseDid slug={slug} phase={record.phase} runId={runId} />
      </Disclosure>
    </li>
  );
}

/** The fold's body — mounted only while open, so the two reads are made only for a phase someone opened. */
function PhaseDid({ slug, phase, runId }: { slug: string; phase: number; runId: string }) {
  const report = usePhaseReport(slug, phase, true, runId);
  const activity = usePhaseActivity(slug, phase, true, 20, runId);
  return (
    <>
      {report.data ? (
        <ReportPart report={report.data} />
      ) : report.isPending ? (
        <Spinner label="Reading the phase’s report" />
      ) : (
        <p className="text-meta text-ink-muted">{failure(report.error)}</p>
      )}
      {activity.data ? (
        <ActivityPart activity={activity.data} />
      ) : activity.isPending ? (
        <Spinner label="Reading the session’s log" />
      ) : (
        <p className="text-meta text-ink-muted">{failure(activity.error)}</p>
      )}
    </>
  );
}

/** A read that failed, in the server's own words — the honest floor when it said nothing. */
const failure = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : 'The read failed and said nothing.';

/** The estimate the report gave, as a sentence. */
function etaWords(eta: PhaseReport['eta']): string {
  if (!eta.minutes) {
    const basis = eta.basis.replace(/\.$/, '');
    return `It gave no estimate${basis ? `: ${basis}` : ''}.`;
  }
  const { low, high } = eta.minutes;
  return high <= 0 ? 'It estimated it was about to finish.' : `It estimated ${low}–${high} minutes left.`;
}

function ReportPart({ report }: { report: PhaseReport }) {
  return (
    <div data-testid="history-report" className="flex min-w-0 max-w-(--measure) flex-col gap-1.5">
      <p className="break-words text-body text-ink">{report.summary}</p>
      <p className="text-meta text-ink-muted tnum">
        {report.done.total > 0
          ? `${report.done.count} of ${plural(report.done.total, 'task')} done, ${report.left.count} left.`
          : 'It published no task list.'}
      </p>
      {report.whySlow.length > 0 && (
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="text-meta text-ink-muted">Why it was slow:</p>
          <ul aria-label="Why it was slow" className="flex min-w-0 flex-col gap-0.5 ps-3">
            {report.whySlow.map((why) => (
              <li key={why.rule} data-rule={why.rule} className="break-words text-meta text-ink">
                {why.text}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-meta text-ink-muted" title={report.eta.basis} data-testid="history-eta">
        {etaWords(report.eta)}
      </p>
    </div>
  );
}

/** A model's words on one line: whitespace folded, cut with an ellipsis. */
function clip(words: string, max: number): string {
  const flat = words.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** One event the session's log holds, in words — the tool and what it ran, a line it wrote, or a marker. */
function ActivityWords({ event }: { event: ActivityEvent }) {
  if (event.kind === 'tool') {
    const what = event.description ?? event.summary ?? '';
    const state = event.open
      ? 'still open'
      : event.exit === 'error'
        ? `failed${event.code != null ? ` (exit ${event.code})` : ''}`
        : '';
    return (
      <span
        className="min-w-0 break-words text-meta text-ink-muted"
        title={what ? clip(what, 2000) : undefined}
      >
        <Mono value={event.name} className="text-ink" />
        {what ? ` ${clip(what, 160)}` : ''}
        {state ? `, ${state}` : ''}
      </span>
    );
  }
  const said = clip(event.text, 240);
  const label =
    event.kind === 'marker'
      ? event.marker === 'input'
        ? 'Told'
        : `${event.marker.charAt(0).toUpperCase()}${event.marker.slice(1)}`
      : null;
  return (
    <span className="min-w-0 break-words text-meta text-ink-muted" title={clip(event.text, 2000)}>
      {label && <span className="text-ink">{label}: </span>}
      {said}
    </span>
  );
}

function ActivityPart({ activity }: { activity: PhaseActivity }) {
  // `events ?? []`: a payload without them (an older server, an error body) is
  // no activity — never a render error.
  const events = activity.events ?? [];
  return (
    <div data-testid="history-activity" data-untrusted="" className="flex min-w-0 flex-col gap-1">
      <p className="text-meta text-ink-muted">
        Read from the session’s own log. These are the model’s words, which the console does not check.
      </p>
      {events.length ? (
        <ol aria-label="What the session did" className="flex min-w-0 flex-col gap-0.5">
          {events.map((event, index) => {
            const at = Date.parse(event.at);
            return (
              <li
                key={`${event.line}-${index}`}
                data-kind={event.kind}
                className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3"
              >
                {Number.isFinite(at) ? (
                  <time
                    dateTime={new Date(at).toISOString()}
                    title={new Date(at).toLocaleString()}
                    className="text-meta text-ink-faint tnum"
                  >
                    {clockTime(at)}
                  </time>
                ) : (
                  <span className="text-meta text-ink-faint">—</span>
                )}
                <ActivityWords event={event} />
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="text-meta text-ink-muted">
          {activity.why ?? 'The session’s log holds nothing for this phase.'}
        </p>
      )}
    </div>
  );
}
