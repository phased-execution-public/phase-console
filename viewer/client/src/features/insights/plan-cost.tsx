/**
 * What this plan cost, and when it lands — the two questions an operator
 * arrives at a plan with once it has been running for a while.
 *
 * Three things here are deliberate and easy to get wrong the other way:
 *
 * **A partial figure is never printed as a total.** `costUnknown` means the
 * session really ran and its spend was never harvested, so `$0.00` would read
 * as "this was free". Those rows carry a `≥` and say why.
 *
 * **The ladder figure is a subset, not a column to add.** `chargeRung` books
 * the same dollars a second time against the rung that caused the attempt, so
 * `total + ladder` double-counts every repair the autopilot ever drove. Same
 * defect class as the day-cap tile P9 fixed.
 *
 * **The forecast's assumptions are rendered, not hidden behind a tooltip.** A
 * date gets quoted long after its caveats are forgotten, and on a phone there
 * is no hover at all. The server computes them (`analysis/stats.ts`
 * `forecastFrom`); this panel only prints them.
 */

import { useMemo, useState } from 'react';
import { BarList } from '@/components/charts';
import {
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Chip,
  CopyButton,
  Empty,
  KeyValue,
  MoneyAmount,
  SectionHeading,
  Tile,
} from '@/components/ui';
import { ToolbarSorts } from '@/components/toolbar';
import { defineSorts } from '@/lib/list-model';
import { duration, money, plural } from '@/lib/format';
import { phaseHref, planHref } from '@shared/routes.js';
import type { Forecast, PlanCost } from '@/lib/api';

/** One phase's money, as the cost report carries it. */
type CostRow = PlanCost['phases'][number];

/**
 * Two orders over the same rows.
 *
 * Dearest-first is the default because it is the question the card answers —
 * *where did the money go* — and plan order is the one you switch to when you
 * are reading down a phase graph rather than a bill.
 */
const { SORTS: COST_SORTS, sortRows: sortCost } = defineSorts<CostRow, 'cost' | 'phase'>({
  cost: {
    label: 'Cost',
    hint: 'dearest first',
    compare: (a, b) => b.usd - a.usd || a.phase - b.phase,
  },
  phase: { label: 'Phase', hint: 'plan order', compare: (a, b) => a.phase - b.phase },
});

/** How many rows the list shows before it asks. Same figure as the QA list beside it. */
const LIST_LIMIT = 20;

/** A local date and time, in the reader's own zone — the server only ever sends the instant. */
function localDate(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';
  return at.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

/**
 * The plan's money and its finish date.
 *
 * `cost` is optional on the wire (a new client against an older server), and
 * absent is rendered as absent rather than as zero — a plan that cost nothing
 * and a server that cannot say are different answers.
 */
export function PlanCostPanel({
  slug,
  cost,
  forecast,
}: {
  slug: string;
  cost: PlanCost | undefined;
  forecast: Forecast | null | undefined;
}) {
  const [sort, setSort] = useState<'cost' | 'phase'>('cost');
  const [all, setAll] = useState(false);
  // Hooks before the early return, and both of them cheap on the empty case:
  // `cost` is absent on an older server, and a conditional hook is a different
  // component every render.
  const spent = useMemo(
    () =>
      sortCost(
        (cost?.phases ?? []).filter((phase) => phase.usd > 0 || phase.partial),
        sort,
      ),
    [cost, sort],
  );

  if (!cost) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>What this plan cost</CardTitle>
        </CardHeader>
        <CardBody>
          <Empty
            title="No cost report"
            body="This console’s server predates per-plan cost attribution, or this plan has never been run by the autopilot."
            action={
              <Button asChild size="sm">
                <a href={planHref(slug, 'run')}>Open the autopilot</a>
              </Button>
            }
          />
        </CardBody>
      </Card>
    );
  }

  const dearest = cost.phases[0];

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label="Total" value={money(cost.totalUsd)} hint={`across ${plural(cost.runs.length, 'run')}`} />
        <Tile
          label="Dearest phase"
          value={dearest ? money(dearest.usd) : '—'}
          hint={dearest ? `P${dearest.phase} · ${plural(dearest.attempts, 'session')}` : 'nothing recorded'}
        />
        <Tile label="Ladder" value={money(cost.ladderUsd)} hint="repair — already inside the total" />
        <Tile
          label="Finish"
          value={forecast ? localDate(forecast.expected) : '—'}
          hint={forecast ? forecast.label : 'no estimate'}
        />
      </div>

      {cost.residualUsd !== 0 && (
        <Banner severity="warn">
          <div className="min-w-0">
            <strong>{money(Math.abs(cost.residualUsd))} of this plan’s spend is not on any phase.</strong>{' '}
            Every session books the same dollars to its run and to its phase record, so these two totals
            normally agree exactly — {money(cost.totalUsd)} spent, {money(cost.attributedUsd)} attributed. A
            gap means a run file disagrees with itself, not that money went somewhere interesting.
          </div>
        </Banner>
      )}

      {cost.partialPhases.length > 0 && (
        <Banner severity="info">
          <div className="min-w-0">
            <strong>
              {plural(cost.partialPhases.length, 'phase')} recorded no cost for a session that ran
            </strong>{' '}
            — {cost.partialPhases.map((phase) => `P${phase}`).join(', ')}. Their figures are floors, marked
            <code className="mx-1">≥</code>, and the plan total is a floor with them.
          </div>
        </Banner>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Per phase</CardTitle>
          <span className="text-2xs text-ink-faint">dearest first · cumulative over every attempt</span>
          {/* The export. Clipboard rather than a download: the numbers are
              usually going straight into an issue or a sheet, and a `Blob`
              download on a localhost console is three more moving parts for a
              paste. The whole console's numbers, in Prometheus text, are at
              `/api/metrics`. */}
          <CopyButton text={() => costCsv(cost)} label="Copy CSV" copiedLabel="CSV copied" />
          {/* The same sort control the plan list and the fleet carry. This list
              had one order and no way to ask for another, which on a
              twenty-phase plan means reading it against the phase graph is a
              scan rather than a read. */}
          {spent.length > 1 && (
            <ToolbarSorts sorts={COST_SORTS} value={sort} onSort={setSort} shape="inline" />
          )}
        </CardHeader>
        <CardBody>
          {spent.length ? (
            <ul className="flex min-w-0 flex-col gap-1">
              {(all ? spent : spent.slice(0, LIST_LIMIT)).map((phase) => (
                <li key={phase.phase} className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  {/* `tap-cell`, not `tap-area`: `P7` is 22px wide in a list
                      of 20px rows, so a 44×44 overlay covered the rows either
                      side of it in exactly the column their own links sit in.
                      44 both ways as the drawn box instead. */}
                  <a
                    href={phaseHref(slug, phase.phase)}
                    className="tap-cell shrink-0 font-mono text-2xs text-ink hover:text-action"
                  >
                    P{phase.phase}
                  </a>
                  <span className="shrink-0 text-sm">
                    {phase.partial && (
                      <span
                        className="mr-0.5 font-mono text-ink-faint"
                        title="a session ran whose spend was never recorded"
                      >
                        &ge;
                      </span>
                    )}
                    <MoneyAmount usd={phase.usd} />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-2xs text-ink-faint">
                    {plural(phase.attempts, 'session')}
                    {phase.durationMs > 0 ? ` · ${duration(phase.durationMs)}` : ''}
                    {phase.runs > 1 ? ` · ${plural(phase.runs, 'run')}` : ''}
                  </span>
                  {phase.model && (
                    <Chip mono className="shrink-0">
                      {phase.model}
                    </Chip>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <Empty
              title="No phase has cost anything yet"
              body="Money is booked to a phase when a session that ran it ends. Nothing here means nothing has run under the autopilot — the plan may still have been worked by hand."
              action={
                <Button asChild size="sm">
                  <a href={planHref(slug, 'run')}>Open the autopilot</a>
                </Button>
              }
            />
          )}
          {spent.length > LIST_LIMIT && (
            <Button
              size="sm"
              variant="ghost"
              className="mt-2"
              onClick={() => setAll((was) => !was)}
              aria-expanded={all}
            >
              {all ? `Show the first ${LIST_LIMIT}` : `Show all ${spent.length}`}
            </Button>
          )}
          <p className="mt-2 text-2xs text-ink-faint">
            Every number on this page is also on{' '}
            <a href="/api/metrics" className="text-action underline">
              <code>/api/metrics</code>
            </a>{' '}
            in Prometheus text, for a scraper.
          </p>
        </CardBody>
      </Card>

      {forecast && (
        <Card>
          <CardHeader>
            <CardTitle>Finish date</CardTitle>
            <span className="text-2xs text-ink-faint">and what it is standing on</span>
          </CardHeader>
          <CardBody className="flex flex-col gap-3">
            <KeyValue
              items={[
                ['Earliest', localDate(forecast.earliest)],
                ['Expected', localDate(forecast.expected)],
                ['Latest', localDate(forecast.latest)],
                [
                  'Working time',
                  // The two quantities kept apart on purpose: the estimate is
                  // how long the WORK takes, the date is when the calendar gets
                  // there, and only one of them shrinks if you run more lanes.
                  `${duration(forecast.workingLowMs)}–${duration(forecast.workingHighMs)} of actual running`,
                ],
              ]}
            />
            <div>
              <SectionHeading as="h4" tone="muted" className="mb-1">
                Assumptions
              </SectionHeading>
              <ul className="list-disc pl-5 text-2xs text-ink-faint">
                {forecast.assumptions.map((line, i) => (
                  <li key={i} className="mt-0.5">
                    {line}
                  </li>
                ))}
              </ul>
            </div>
          </CardBody>
        </Card>
      )}

      {cost.byModel.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>By model</CardTitle>
            <span className="text-2xs text-ink-faint">a phase books to the model it ENDED on</span>
          </CardHeader>
          <CardBody>
            <BarList
              label="models"
              items={cost.byModel.map((row) => ({ name: row.model, value: row.usd }))}
              unit=" USD"
            />
          </CardBody>
        </Card>
      )}

      {cost.byDay.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>By day</CardTitle>
            <span className="text-2xs text-ink-faint">
              {cost.byDayTruncated ? `newest ${cost.byDay.length} days` : `${cost.byDay.length} days`}
            </span>
          </CardHeader>
          <CardBody>
            <BarList
              label="days"
              items={cost.byDay.map((row) => ({ name: row.day, value: row.usd }))}
              unit=" USD"
            />
            <p className="mt-2 text-2xs text-ink-faint">
              A phase books its whole cost on the day it ENDED, in the operator’s zone — so a phase begun
              Monday and finished Wednesday is a Wednesday bar.
              {cost.byDayTruncated
                ? ' Older days are not shown; this plan has been running longer than the chart.'
                : ''}
            </p>
          </CardBody>
        </Card>
      )}
    </div>
  );
}

/**
 * The same numbers as CSV, for a spreadsheet or a paste into an issue.
 *
 * Exported and pure so it can be tested without a DOM: the download is one
 * `Blob` away, and the thing worth pinning is the CONTENT — a header row that
 * names its units and a `partial` column, because a floor exported as a total
 * is the same lie as a floor rendered as one.
 */
export function costCsv(cost: PlanCost): string {
  const escape = (value: string | number): string => {
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const rows = [
    ['phase', 'usd', 'partial', 'sessions', 'runs', 'seconds', 'model', 'status', 'ended_at'],
    ...cost.phases.map((phase) => [
      phase.phase,
      phase.usd,
      phase.partial ? 'true' : 'false',
      phase.attempts,
      phase.runs,
      Math.round(phase.durationMs / 1000),
      phase.model ?? '',
      phase.status ?? '',
      phase.endedAt ?? '',
    ]),
  ];
  return `${rows.map((row) => row.map(escape).join(',')).join('\n')}\n`;
}
