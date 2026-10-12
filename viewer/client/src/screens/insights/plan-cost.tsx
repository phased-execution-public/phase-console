/**
 * What this plan cost, and when it lands — the two questions an operator
 * arrives at a plan with once it has been running a while.
 *
 * Three things here are deliberate and easy to get wrong the other way:
 *
 * **A partial figure is never printed as a total.** `partial` means a session
 * really ran and its spend was never harvested, so `$0.00` would read as
 * "this was free". Those rows carry a `≥` and say why.
 *
 * **The ladder figure is a subset, not a column to add.** `chargeRung` books
 * the same dollars a second time against the rung that caused the attempt, so
 * the total plus the ladder double-counts every repair the autopilot drove.
 *
 * **The forecast's assumptions are printed, not hidden behind a hover.** A
 * date gets quoted long after its caveats are forgotten, and a phone has no
 * hover at all. The server makes them (`analysis/stats.ts` `forecastFrom`);
 * this panel only prints them.
 */

import { useMemo, useState } from 'react';
import type { Forecast, PlanCost } from '@/data/api';
import { consolePath } from '@/lib/base';
import { duration, money, plural } from '@/lib/format';
import { phaseHref, planHref } from '@/shell/routes';
import { Banner, Button, Empty, KeyValue, Money, Mono, SectionHeading } from '@/ui';
import { CopyButton } from '@/ui/copy-button';
import { Disclosure } from '@/ui/disclosure';
import { BarList } from '@/ui/figures/lazy';
import type { Column } from '@/ui/grid/column';
import { Grid } from '@/ui/grid/grid';
import { FactRows, FigureBlock, InsightNote, PROSE_LINK } from './parts';

/** One phase's money, as the cost report carries it. */
type CostRow = PlanCost['phases'][number];
type CostSort = 'cost' | 'phase';

/** Dearest first answers the card's question; plan order is for reading it down a phase graph. */
const ORDER: Readonly<Record<CostSort, (a: CostRow, b: CostRow) => number>> = {
  cost: (a, b) => b.usd - a.usd || a.phase - b.phase,
  phase: (a, b) => a.phase - b.phase,
};

/** A local date in the reader's own zone — the server only ever sends the instant. */
function localDate(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';
  return at.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function phaseColumns(slug: string): Column<CostRow>[] {
  return [
    {
      id: 'phase',
      head: 'Phase',
      priority: 1,
      min: 72,
      identity: true,
      card: 'title',
      sort: { id: 'phase', dir: 'ascending' },
      value: (row) => row.phase,
      cell: (row) => <span className="tnum text-ink">P{row.phase}</span>,
    },
    {
      id: 'cost',
      head: 'Cost',
      priority: 1,
      min: 104,
      align: 'end',
      card: 'meta',
      sort: { id: 'cost', dir: 'descending' },
      value: (row) => row.usd,
      cell: (row) => (
        <span className="tnum">
          {row.partial ? (
            <span className="me-0.5 text-ink-muted" title="A session ran whose spend was never recorded">
              ≥
            </span>
          ) : null}
          <Money usd={row.usd} />
        </span>
      ),
    },
    {
      id: 'sessions',
      head: 'Sessions',
      priority: 2,
      min: 104,
      card: 'meta',
      value: (row) => row.attempts,
      cell: (row) => plural(row.attempts, 'session'),
    },
    {
      id: 'time',
      head: 'Time',
      priority: 3,
      min: 88,
      value: (row) => row.durationMs,
      cell: (row) =>
        row.durationMs > 0 ? duration(row.durationMs) : <span className="text-ink-muted">—</span>,
    },
    {
      id: 'runs',
      head: 'Runs',
      priority: 3,
      min: 80,
      value: (row) => row.runs,
      cell: (row) => plural(row.runs, 'run'),
    },
    {
      id: 'model',
      head: 'Model',
      priority: 2,
      min: 160,
      flex: true,
      value: (row) => row.model ?? null,
      cell: (row) => (row.model ? <Mono value={row.model} /> : <span className="text-ink-muted">—</span>),
    },
    {
      id: 'link',
      head: 'Phase page',
      min: 120,
      everything: true,
      value: () => null,
      cell: (row) => (
        <a href={phaseHref(slug, row.phase)} className={PROSE_LINK}>
          Open P{row.phase}
        </a>
      ),
    },
  ];
}

export function PlanCostPanel({
  slug,
  cost,
  forecast,
  everything = false,
}: {
  slug: string;
  cost: PlanCost | undefined;
  forecast: Forecast | null | undefined;
  everything?: boolean;
}) {
  const [sort, setSort] = useState<CostSort>('cost');
  // Before the early return: `cost` is absent on an older server, and a
  // conditional hook would be a different component every render.
  const spent = useMemo(
    () => (cost?.phases ?? []).filter((phase) => phase.usd > 0 || phase.partial).sort(ORDER[sort]),
    [cost, sort],
  );
  const columns = useMemo(() => phaseColumns(slug), [slug]);

  if (!cost) {
    return (
      <Empty
        title="No cost report: this console’s server predates per-plan cost, or the autopilot has never run this plan."
        action={
          <Button size="sm" asChild>
            <a href={planHref(slug, 'run')}>Open the run</a>
          </Button>
        }
      />
    );
  }

  const dearest = cost.phases[0];
  // An absent forecast, a working-time-only one (no measurable duty cycle) and
  // a dated one are three different answers, never one fallback for two.
  const finish = !forecast
    ? '—'
    : forecast.calendar === 'known' && forecast.expected
      ? localDate(forecast.expected)
      : 'unknown';

  return (
    <div className="flex min-w-0 flex-col gap-5" data-testid="insights-plan-cost">
      <FactRows
        facts={[
          { label: 'Total', value: money(cost.totalUsd), hint: `across ${plural(cost.runs.length, 'run')}` },
          {
            label: 'Dearest phase',
            value: dearest ? money(dearest.usd) : '—',
            hint: dearest ? `P${dearest.phase}, ${plural(dearest.attempts, 'session')}` : 'nothing recorded',
          },
          { label: 'Ladder', value: money(cost.ladderUsd), hint: 'repair, already inside the total' },
          { label: 'Finish', value: finish, hint: forecast ? forecast.label : 'no estimate' },
        ]}
      />

      {cost.residualUsd !== 0 && (
        <Banner severity="warn">
          {money(Math.abs(cost.residualUsd))} of this plan’s spend is on no phase: {money(cost.totalUsd)}{' '}
          spent, {money(cost.attributedUsd)} attributed. Every session books the same dollars to its run and
          its phase, so a gap means a run file disagrees with itself, not that money went somewhere else.
        </Banner>
      )}

      {cost.partialPhases.length > 0 && (
        <Banner severity="info">
          {plural(cost.partialPhases.length, 'phase')} recorded no cost for a session that ran (
          {cost.partialPhases.map((phase) => `P${phase}`).join(', ')}). Their figures are floors, marked ≥,
          and the plan total is a floor with them.
        </Banner>
      )}

      <div className="flex min-w-0 flex-col gap-2">
        <SectionHeading
          as="h3"
          aside={
            <CopyButton
              text={() => costCsv(cost)}
              label="Copy as CSV"
              copiedLabel="CSV copied"
              variant="ghost"
            />
          }
        >
          Per phase
        </SectionHeading>
        {spent.length ? (
          // The numbers behind the figures above, folded as a figure's are:
          // the figures answer at a glance, every phase is one press away.
          <Disclosure label="The phases" openLabel="Hide the phases" count={spent.length}>
            <Grid
              columns={columns}
              rows={spent}
              getRowKey={(row) => String(row.phase)}
              label="Each phase's cost, over every attempt"
              tableId="insights-plan-cost"
              everything={everything}
              rowHref={(row) => phaseHref(slug, row.phase)}
              activeSort={sort}
              onSort={(id) => setSort(id === 'phase' ? 'phase' : 'cost')}
            />
          </Disclosure>
        ) : (
          <Empty
            title="No phase has cost anything yet: money is booked to a phase when a session that ran it ends."
            action={
              <Button size="sm" asChild>
                <a href={planHref(slug, 'run')}>Open the run</a>
              </Button>
            }
          />
        )}
        {everything && (
          <InsightNote>
            Each phase is cumulative over every attempt. Every figure here is also on{' '}
            <a href={consolePath('/api/metrics')} className={PROSE_LINK}>
              /api/metrics
            </a>{' '}
            in Prometheus text, for a scraper.
          </InsightNote>
        )}
      </div>

      {forecast && (
        <div className="flex min-w-0 flex-col gap-2">
          <SectionHeading as="h3">Finish date</SectionHeading>
          <KeyValue
            items={[
              // Present only when the duty cycle could measure a pace to project:
              // `calendar === 'unknown'` means no date exists at all.
              forecast.calendar === 'known' && forecast.earliest
                ? (['Earliest', localDate(forecast.earliest)] as const)
                : null,
              forecast.calendar === 'known' && forecast.expected
                ? (['Expected', localDate(forecast.expected)] as const)
                : null,
              forecast.calendar === 'known' && forecast.latest
                ? (['Latest', localDate(forecast.latest)] as const)
                : null,
              // Kept apart on purpose: the work is how long it takes, the date
              // when the calendar gets there — only one shrinks with more lanes.
              [
                'Working time',
                `${duration(forecast.workingLowMs)} to ${duration(forecast.workingHighMs)} of work`,
              ],
            ]}
          />
          <div className="flex min-w-0 flex-col gap-1">
            <h4 className="text-meta text-ink-muted">Assumptions</h4>
            <ul className="flex max-w-(--measure) list-disc flex-col gap-0.5 ps-5 text-meta text-ink-muted">
              {forecast.assumptions.map((line, index) => (
                <li key={index}>{line}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {(cost.byModel.length > 0 || cost.byDay.length > 0) && (
        <div className="grid min-w-0 gap-6 lg:grid-cols-2">
          {cost.byModel.length > 0 && (
            <FigureBlock caption="By model, booked to the model each phase ended on">
              <BarList
                label="models"
                format={money}
                items={cost.byModel.map((row) => ({ name: row.model, value: row.usd }))}
              />
            </FigureBlock>
          )}
          {cost.byDay.length > 0 && (
            <FigureBlock caption={cost.byDayTruncated ? `By day, the newest ${cost.byDay.length}` : 'By day'}>
              <BarList
                label="days"
                format={money}
                items={cost.byDay.map((row) => ({ name: row.day, value: row.usd }))}
              />
              <InsightNote>
                A phase books its whole cost on the day it ended, in the operator’s zone: one begun Monday and
                finished Wednesday is a Wednesday bar.
                {cost.byDayTruncated
                  ? ' Older days are not shown; the plan has run longer than the figure.'
                  : ''}
              </InsightNote>
            </FigureBlock>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The same numbers as CSV, for a spreadsheet or a paste into an issue.
 *
 * Exported and pure so it is tested without a DOM: the thing worth pinning is
 * the CONTENT — a header that names its units and a `partial` column, because
 * a floor exported as a total is the same lie as a floor printed as one.
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
