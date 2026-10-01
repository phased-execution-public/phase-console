/**
 * How long is left — the estimate, and what it is standing on.
 *
 * An ETA with no basis is a guess wearing a number. Every figure here carries
 * the `EtaBasis` that produced it — `plan` (this plan's own completed phases),
 * `portfolio` (pooled across every plan, used until a plan has evidence of its
 * own) and `heuristic` (the shipped constants, i.e. nobody has finished
 * anything yet) — because the same "≈ 3 days" means three different things
 * depending on which one it is, and only one of them is worth planning around.
 *
 * The server owns the arithmetic (`analysis/stats.ts`). This panel never
 * computes a duration: a client that did would drift from the lane ETAs on Now
 * and the plan ETA on the Route tab, and three surfaces disagreeing about when
 * something finishes is worse than one surface saying it does not know.
 */

import { Button, Card, CardBody, CardHeader, CardTitle, Empty, KeyValue, Tile } from '@/components/ui';
import { runsBayHref } from '@/app/routes';
import { planHref, planViewHref } from '@shared/routes.js';
import { duration, plural, weight } from '@/lib/format';
import type { EtaEstimate, PlanSummaryFull, Portfolio } from '@/lib/api';
import { recentRate } from './portfolio';

/** What a basis actually claims, in a sentence. */
const BASIS_NOTE: Record<string, string> = {
  plan: 'measured from this plan’s own completed phases.',
  portfolio: 'pooled across every plan — this one has not finished enough phases to speak for itself.',
  heuristic: 'the shipped constants. Nothing has completed yet, so this is a placeholder, not a forecast.',
};

/**
 * `N measured phase(s) weighted` — and, when some finished phases taught the
 * rate nothing (a closeout-only completion, a duration nobody recorded), how
 * many were left out. The evidence count is never silently smaller than what
 * actually finished.
 */
function samplesRow(samples: number, missing: number): string {
  const leftOut = missing ? `, ${missing} left out — no usable measurement` : '';
  return `${plural(samples, 'measured phase')} weighted${leftOut}`;
}

export function EtaPanel({
  stats,
  mediumWeight,
  plan,
  planEta,
  planStats,
}: {
  stats: Portfolio;
  mediumWeight: number | undefined;
  plan?: string;
  planEta?: EtaEstimate | null;
  /** The scoped plan's own analysis, for the floor under its estimate. */
  planStats?: PlanSummaryFull;
}) {
  const t = stats.totals;
  const rate = stats.rate;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile
          label="Work left"
          value={weight(t.remainingWeight)}
          hint={`across ${plural(t.plans - t.closed, 'open plan')}`}
        />
        <Tile
          label="Sessions left"
          value={t.remainingSessions}
          hint="1 phase ≥ 1 session, measured per phase"
        />
        <Tile
          label="Ready now"
          value={t.ready}
          state={t.ready > 0 ? 'state-queued' : undefined}
          hint={`${t.inProgress} in flight`}
        />
        <Tile
          label="Median gap"
          value={
            stats.medianCycleDays == null
              ? '—'
              : stats.medianCycleDays === 0
                ? 'same day'
                : `${stats.medianCycleDays}d`
          }
          hint="between one phase and the next"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{plan ? `${plan} — estimate` : 'Portfolio estimate'}</CardTitle>
          <span className="text-2xs text-ink-faint">the server’s arithmetic, never the client’s</span>
        </CardHeader>
        <CardBody className="flex flex-col gap-3">
          {plan ? (
            planEta ? (
              <KeyValue
                items={[
                  ['Estimate', planEta.label],
                  ['Phases left', `${planEta.remainingPhases} · ${weight(planEta.remainingWeight)}`],
                  ['Basis', `${planEta.basis} — ${BASIS_NOTE[planEta.basis] ?? 'unknown'}`],
                  ['Samples', samplesRow(planEta.samples, planEta.missing)],
                  [
                    'Model',
                    `${duration(planEta.floorMs)} + ${Math.round(planEta.slopeMsPerWeight)} ms per weight`,
                  ],
                  ...floorRow(plan, planStats),
                ]}
              />
            ) : (
              <Empty
                title="No estimate for this plan"
                body="Every phase is done, or this console’s server predates the per-plan ETA."
                action={
                  <Button asChild size="sm">
                    <a href={planHref(plan)}>Open the plan</a>
                  </Button>
                }
              />
            )
          ) : rate && rate.basis !== 'heuristic' ? (
            <KeyValue
              items={[
                [
                  'Recent rate',
                  `${recentRate(rate, mediumWeight).replace(/^ · recent rate ≈ /, '') || 'unknown'}`,
                ],
                ['Basis', `${rate.basis} — ${BASIS_NOTE[rate.basis] ?? 'unknown'}`],
                ['Samples', samplesRow(rate.samples, rate.missing)],
                [
                  // The band is the spread of the MEASURED phases around the
                  // model — the 75th percentile of how far each one fell from
                  // it (server/analysis/stats.ts) — never a reading of how
                  // many of them there were. `spread` runs the same FACTOR
                  // above the point and below it (point ÷ (1+spread) … point
                  // × (1+spread)), so it is stated as that factor both ways —
                  // a `±` percent would misstate the lower end.
                  'Confidence band',
                  `÷${(1 + rate.spread).toFixed(1)} to ×${(1 + rate.spread).toFixed(1)} of the estimate — where three in four measured phases fell`,
                ],
              ]}
            />
          ) : (
            <Empty
              title="No measured rate yet"
              body="Estimates fall back to the shipped constants until phases start completing."
              action={
                <Button asChild size="sm">
                  <a href={runsBayHref('ready')}>See what could start</a>
                </Button>
              }
            />
          )}
          <p className="text-2xs text-ink-faint">
            A phase&rsquo;s own estimate is on its row; a run&rsquo;s is on the run page; a lane&rsquo;s is on
            Now. All four read the same rate.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}

/**
 * What the dependency chain costs an estimate — the floor no parallelism moves.
 *
 * The plan page already counts the critical path and names the bottleneck, and
 * this deliberately does not repeat either: what it gives is the thing an
 * ESTIMATE needs and a count cannot say, which is how much of the remaining
 * work could go beside the chain rather than after it. "Twelve sessions left,
 * of which at least five must be sequential" and "twelve sessions left" are the
 * same number and completely different plans — the first says seven could run
 * in another checkout tonight.
 *
 * Silent when the server does not say (an older console) or when the chain
 * accounts for everything, because "0 could run beside it" is a sentence that
 * tells a reader they have a choice they do not have.
 */
function floorRow(plan: string, stats: PlanSummaryFull | undefined): [string, React.ReactNode][] {
  const minimum = stats?.minimumSessions;
  const remaining = stats?.remainingSessions;
  if (typeof minimum !== 'number' || typeof remaining !== 'number' || minimum < 1) return [];
  const beside = remaining - minimum;
  return [
    [
      'Floor',
      <span key="floor">
        {plural(minimum, 'session')} must run in order —{' '}
        {beside > 0
          ? `${plural(beside, 'session')} of the ${remaining} could run beside the chain`
          : 'the dependency chain accounts for all of it'}
        .{' '}
        <a href={planViewHref(plan, 'map')} className="text-action underline">
          The route map
        </a>{' '}
        draws it.
      </span>,
    ],
  ];
}
