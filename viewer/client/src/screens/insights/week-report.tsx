/**
 * This week — the week in numbers over this console's stored runs, and the
 * acceptance targets judged on them (`GET /api/report`, the fold
 * `phase-console report` prints).
 *
 * The verdicts lead: each target is a dot and a word — OK, Fail, or Not asked
 * when the week held nothing to judge it on — its sentence and the figure it
 * was judged by. The measurements behind them are one press away. A person
 * can step back a week at a time (`until`; the window is the week before it)
 * and replay the old journals with today's models (`replay`), which is how a
 * target is measured without waiting a week. The server remembers each
 * question for five minutes, and so does the page.
 *
 * The question reads its own answer, so its controls stay put while a new
 * window is read: what is held busy is the answer under them, at about its
 * answered height (#247).
 */

import { useState, type ReactNode } from 'react';
import { ApiError } from '@/data/http';
import { useWeekReport } from '@/data/runs';
import { sourceHref } from '@/shell/routes';
import { Button, Empty, Mono, RelativeTime, Skeleton } from '@/ui';
import { Checkbox } from '@/ui/checkbox';
import { Disclosure } from '@/ui/disclosure';
import { NativeSelect } from '@/ui/native-select';
import { OpsStatus } from '@/ui/status';
import { weekFacts } from './model';
import { FactRows, InsightAnswer, InsightNote } from './parts';

const WEEK_MS = 7 * 24 * 60 * 60_000;

/** The windows on offer, by how many weeks back each ends. */
const WINDOWS = ['The last seven days', 'The week before', 'Two weeks before', 'Three weeks before'] as const;

/** A moment as a reader wants it: the date and the time, in their own locale. */
function When({ at }: { at: string }) {
  const date = new Date(at);
  return (
    <time dateTime={at} className="tnum">
      {Number.isNaN(date.getTime())
        ? at
        : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
    </time>
  );
}

/** A server sentence as the start of a line. */
const sentence = (words: string): string => words.charAt(0).toUpperCase() + words.slice(1);

/** A target's verdict as the probe words say it: met, missed, or nothing to judge. */
const verdict = (met: boolean | null) => (met === true ? 'ok' : met === false ? 'fail' : 'skip');

export function WeekReportPanel({ everything = false }: { everything?: boolean }) {
  const [back, setBack] = useState(0);
  // The window's end is fixed when it is chosen: an instant read on every
  // render would be a new question, and a new read, each time.
  const [until, setUntil] = useState<string | undefined>(undefined);
  const [replay, setReplay] = useState(false);
  const { data, error, refetch } = useWeekReport({ until, replay });

  const choose = (weeks: number) => {
    setBack(weeks);
    setUntil(weeks ? new Date(Date.now() - weeks * WEEK_MS).toISOString() : undefined);
  };

  let answer: ReactNode;
  if (error) {
    answer =
      error instanceof ApiError && error.status === 409 ? (
        <Empty
          title="No plan directory is open, so there are no runs to report on."
          action={
            <Button size="sm" asChild>
              <a href={sourceHref()}>Choose a source directory</a>
            </Button>
          }
        />
      ) : (
        <Empty
          title={`The week could not be read: ${error.message || 'the read failed and said nothing.'}`}
          action={
            error instanceof ApiError && error.status === 400 ? (
              <Button size="sm" onClick={() => choose(0)}>
                Show the last seven days
              </Button>
            ) : (
              <Button size="sm" onClick={() => void refetch()}>
                Try again
              </Button>
            )
          }
        />
      );
  } else if (!data) {
    answer = (
      <div aria-busy="true" className="min-w-0">
        <Skeleton className="h-[34rem]" />
      </div>
    );
  } else {
    const report = data.report;
    const facts = weekFacts(report.metrics);
    answer = (
      <div className="flex min-w-0 flex-col gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <InsightAnswer>
            The week from <When at={report.since} /> to <When at={report.until} />
            {report.replay.length ? `, replayed with today’s ${report.replay.join(', ')} models` : ''}.
          </InsightAnswer>
          <p className="text-meta text-ink-muted" data-testid="week-read">
            Read <RelativeTime at={data.readAt} />
            {data.cached ? ', remembered from the same question' : ''}.
          </p>
        </div>
        <ul
          className="flex min-w-0 flex-col divide-y divide-rule"
          aria-label="The targets, judged on this week"
        >
          {report.targets.map((target) => (
            // The word and the target share a line on a desk; on a phone the
            // word sits over its sentence, and the figure is its own line.
            <li
              key={target.id}
              data-target={target.id}
              className="grid min-w-0 gap-x-4 gap-y-0.5 py-2 sm:grid-cols-[5.5rem_minmax(0,1fr)] sm:items-baseline"
            >
              <OpsStatus vocab="probe" word={verdict(target.met)} />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="min-w-0 text-body break-words text-ink">{sentence(target.target)}</span>
                <span className="min-w-0 text-meta break-words text-ink-muted">{target.value}</span>
              </span>
            </li>
          ))}
        </ul>
        <Disclosure label="Every measurement" openLabel="Hide the measurements" count={facts.length}>
          <div className="mt-2">
            <FactRows facts={facts} />
          </div>
        </Disclosure>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="insights-week">
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
        <NativeSelect
          aria-label="The week to report on"
          className="w-full sm:w-56"
          value={String(back)}
          onChange={(event) => choose(Number(event.target.value))}
        >
          {WINDOWS.map((label, weeks) => (
            <option key={label} value={weeks}>
              {label}
            </option>
          ))}
        </NativeSelect>
        <label className="flex min-w-0 items-center gap-2 text-body text-ink [@media(hover:none)]:min-h-(--tap-min)">
          <Checkbox
            checked={replay}
            aria-label="Replay with today’s models"
            onCheckedChange={(next) => setReplay(next === true)}
          />
          Replay with today’s models
        </label>
      </div>
      {answer}
      {everything && (
        <InsightNote>
          Read from every journal this console holds, the way{' '}
          <Mono value="phase-console report --since <iso> --until <iso> --replay" words /> prints it. A replay
          re-derives the failure streak, the booked spend, the phase estimate and the holder estimate with
          today’s rules.
        </InsightNote>
      )}
    </div>
  );
}
