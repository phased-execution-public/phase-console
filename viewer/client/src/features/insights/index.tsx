/**
 * Insights — the destination.
 *
 * 2.x `#/stats` was one scroll of thirteen cards titled *Statistics*, and the
 * plan page had a seventh tab called *Analysis* that computed some of the same
 * numbers again for one plan. 3.0 makes them one surface with a scope: bare
 * `#/insights` is the portfolio, `#/insights?plan=<slug>` is one plan, and the
 * retired `#/plan/:slug/analysis` redirects here carrying its slug (see
 * `LEGACY_PLAN_TABS`).
 *
 * Six panels, each answering a different question and none repeating another
 * (one of them, `plan-cost`, only has an answer when the page is scoped):
 *
 *   **How long is left** (`eta`)          — the estimate and the basis under it
 *   **What it costs** (`cost-vs-caps`)    — settled today against the day cap
 *   **What THIS plan cost** (`plan-cost`) — per-phase USD and a finish date
 *                                           (plan scope only)
 *   **How fast** (`velocity`)             — the trend and its texture
 *   **What shape** (`portfolio`)          — states, sizes, locks, health
 *   **On what** (`model`)                 — repos, skills, target models
 *
 * The order is deliberate: the two questions an operator actually arrives with
 * are *when will this be done* and *what is it costing*, and both used to be
 * below the fold under three charts.
 *
 * The plan scope is honest about what it can narrow. `/api/stats` is a
 * portfolio aggregate with no per-plan breakdown, so a scoped view shows what
 * genuinely IS plan-scoped — the plan's own ETA, its runs' spend, its QA
 * reports, its locks and its issues — and says so, rather than re-labelling
 * portfolio-wide charts with a plan's name.
 */

import { useMemo, useState } from 'react';
import type { ViewProps } from '@/app/router';
import { navigate } from '@/app/router';
import { insightsHref } from '@/app/routes';
import { Page } from '@/components/page';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Chip,
  Empty,
  PageError,
  SectionHeading,
  Skeleton,
  StatusBadge,
  field,
} from '@/components/ui';
import { ToolbarSorts } from '@/components/toolbar';
import { cn } from '@/lib/cn';
import { defineSorts } from '@/lib/list-model';
import { plural } from '@/lib/format';
import { isClosed } from '@/lib/closure';
import { UI_STATES, qaResultTitle, qaUiState } from '@/lib/status-vocab';
import { planHref, handoffHref } from '@shared/routes.js';
import { useConsoleState, usePlan, usePlans, useSpend, useStats } from '@/lib/queries';
import { PortfolioPanel } from './portfolio';
import { VelocityPanel } from './velocity';
import { CostVsCapsPanel } from './cost-vs-caps';
import { PlanCostPanel } from './plan-cost';
import { EtaPanel } from './eta';
import { MixPanel } from './model';
import { qaReportHref, qaReportRound } from '@/lib/qa';

export default function InsightsView({ route }: ViewProps) {
  const plan = route.query.plan || undefined;
  const { data: stats, isPending, error, refetch } = useStats();
  const { data: state } = useConsoleState();
  const { data: spend } = useSpend();
  const { data: plans } = usePlans();
  const { data: detail } = usePlan(plan);
  const allowWrites = Boolean(state?.allowWrites);

  // Which slugs are closed, so an issue row can say so and can stop offering a
  // repair the server would refuse anyway (`plan-repair` 409s on a closed
  // plan). `/api/plans` rather than a new wire field: every other page has
  // already fetched it, so this is a cache read.
  const closedSlugs = useMemo(
    () => new Set((plans ?? []).filter((p) => isClosed(p)).map((p) => p.slug)),
    [plans],
  );

  if (error) {
    return (
      <Page title="Insights">
        <PageError error={error} retry={refetch} />
      </Page>
    );
  }

  if (isPending || !stats) {
    return (
      <Page title="Insights" subtitle="Reading every plan">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-20" />
          ))}
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-40" />
          ))}
        </div>
      </Page>
    );
  }

  const t = stats.totals;
  const generated = new Date(stats.generatedAt).toISOString().slice(0, 16).replace('T', ' ');

  return (
    <Page
      title="Insights"
      subtitle={`${plan ? plan : 'Portfolio'} · ${generated}`}
      actions={
        <>
          <label htmlFor="insights-plan" className="sr-only">
            Scope to a plan
          </label>
          <select
            id="insights-plan"
            value={plan ?? ''}
            onChange={(event) => navigate(insightsHref(event.target.value || undefined))}
            /* The shared control class, plus this select's own width bound:
               its options are plan SLUGS, and a select is as wide as its
               longest one — unbounded, a single long slug made a 423 px
               control inside a 390 px phone and scrolled the whole app
               sideways. */
            className={cn(field, 'w-full max-w-56 min-w-0')}
          >
            <option value="">Every plan</option>
            {(plans ?? []).map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.slug}
              </option>
            ))}
          </select>
          <Chip mono>{plural(t.plans, 'plan')}</Chip>
          {t.orphans > 0 && (
            <Chip mono tone="warn">
              {plural(t.orphans, 'orphan folder')}
            </Chip>
          )}
        </>
      }
    >
      <div className="flex min-w-0 flex-col gap-6">
        <Section title="How long is left">
          <EtaPanel
            stats={stats}
            mediumWeight={state?.sizing?.M}
            plan={plan}
            planEta={plan ? (detail?.eta?.plan ?? null) : undefined}
            planStats={plan ? detail?.summary : undefined}
          />
        </Section>

        <Section title="What it costs">
          <CostVsCapsPanel spend={spend} plan={plan} />
        </Section>

        {/* Scoped only. `/api/spend` above is the console's money against its
            caps; this is ONE plan's money against its own phases, and it comes
            off that plan's run files rather than out of the portfolio
            aggregate. There is nothing portfolio-wide to show here, so nothing
            is shown. */}
        {plan ? (
          <Section title="What this plan cost">
            <PlanCostPanel slug={plan} cost={detail?.cost} forecast={detail?.forecast} />
          </Section>
        ) : null}

        {plan ? (
          <Section title="This plan’s record">
            <PlanRecord slug={plan} qa={detail?.qa ?? []} />
          </Section>
        ) : null}

        <Section title="How fast">
          <VelocityPanel stats={stats} />
        </Section>

        <Section title="What shape the work is in">
          {plan && (
            <p className="mb-3 text-2xs text-ink-faint">
              Portfolio-wide. <code>/api/stats</code> aggregates across every plan and does not break these
              down per plan —{' '}
              <a href={planHref(plan, 'phases')} className="text-action underline">
                {plan}&rsquo;s own phases
              </a>{' '}
              are on its plan page.
            </p>
          )}
          <PortfolioPanel
            stats={stats}
            allowWrites={allowWrites}
            closedSlugs={closedSlugs}
            sizing={state?.sizing}
          />
        </Section>

        <Section title="On what">
          <MixPanel stats={stats} />
        </Section>
      </div>
    </Page>
  );
}

/**
 * A titled band. `<h2>` because the page's `<h1>` is *Insights* — a screen
 * reader walking headings then gets the five questions as the outline.
 */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const id = `insights-${title.replace(/[^a-z]+/gi, '-').toLowerCase()}`;
  return (
    <section aria-labelledby={id} className="min-w-0">
      <SectionHeading id={id} size="title" className="mb-3">
        {title}
      </SectionHeading>
      {children}
    </section>
  );
}

/** One recorded QA verdict, as the plan detail carries it. */
type QaRow = { phase: number; result: string; report?: string };

/**
 * Two orders, and the second one is why the control exists: a plan with
 * twenty-two verdicts reads as a wall of `pass` in plan order, and the one
 * `fail` in it is wherever its phase number puts it.
 *
 * Worst-first is not a rank written here — it is the position of the verdict's
 * UI state in `UI_STATES`, which is the vocabulary's own worst-first order. A
 * word this console does not know sorts last rather than first.
 */
const qaRank = (result: string): number => {
  const at = UI_STATES.indexOf(qaUiState(result));
  return at < 0 ? UI_STATES.length : at;
};

const { SORTS: QA_SORTS, sortRows: sortQa } = defineSorts<QaRow, 'phase' | 'verdict'>({
  phase: { label: 'Phase', hint: 'plan order', compare: (a, b) => a.phase - b.phase },
  verdict: {
    label: 'Verdict',
    hint: 'failures first',
    compare: (a, b) => qaRank(a.result) - qaRank(b.result) || a.phase - b.phase,
  },
});

/** How many rows a card shows before it asks. Long enough to be the whole answer on most plans. */
const LIST_LIMIT = 20;

/**
 * The plan-scoped record — where the QA reports finally have a home.
 *
 * Phase 9 retired the Analysis tab and found these homeless: `PlanDetail.qa`
 * carries a report PATH per phase and no surface rendered it, so a verdict an
 * operator could act on was a file only somebody who already knew the
 * convention could find. Every row links to the phase; a row with a report
 * links to the file too.
 *
 * Exported for its own test: it takes two plain values and holds its order and
 * its bound in local state, so it is testable without assembling the whole
 * destination around it.
 */
export function PlanRecord({ slug, qa }: { slug: string; qa: QaRow[] }) {
  const [sort, setSort] = useState<'phase' | 'verdict'>('phase');
  const [all, setAll] = useState(false);
  const rows = useMemo(() => sortQa(qa, sort), [qa, sort]);
  const shown = all ? rows : rows.slice(0, LIST_LIMIT);

  return (
    <Card>
      <CardHeader>
        <CardTitle>QA verdicts</CardTitle>
        <span className="text-2xs text-ink-faint">from test-status.md</span>
        {/* The same control the plan list and the fleet use, in a card header.
            This list and the per-phase cost list beside it were the only two
            in the console with no order of their own — which on a long plan
            means the one `fail` is wherever its phase number puts it. */}
        {rows.length > 1 && <ToolbarSorts sorts={QA_SORTS} value={sort} onSort={setSort} shape="inline" />}
      </CardHeader>
      <CardBody>
        {rows.length ? (
          <>
            <ul className="flex min-w-0 flex-col gap-1">
              {shown.map((row) => (
                <li key={row.phase} className="flex flex-wrap items-baseline gap-2">
                  {/* `tap-cell` for the reason `plan-cost.tsx` gives at its own
                      `P<n>` link, and this one was missed in the first pass:
                      measured at 360/768/1024 with the coarse branch live it
                      was 14.5×18.6 and won none of the four corners of its own
                      44×44 floor. It is a glyph-width token in a list of 19px
                      rows, so the floor has to be the drawn box — an overlay
                      would cover the rows either side in the column their own
                      links sit in. */}
                  <a
                    href={handoffHref(slug, row.phase)}
                    className="tap-cell shrink-0 font-mono text-2xs text-ink hover:text-action"
                  >
                    P{row.phase}
                  </a>
                  {/* The verdict through the QA vocabulary, so it is painted
                      the same hue here as on the phase row and the board. */}
                  <StatusBadge
                    state={qaUiState(row.result)}
                    label={row.result}
                    title={qaResultTitle(row.result)}
                  />
                  {row.report ? (
                    // A real link to the report sheet on the plan's QA tab —
                    // this was an inert span despite the card's own docstring.
                    <a
                      href={qaReportHref(slug, row.phase, qaReportRound(row.report))}
                      className="min-w-0 flex-1 truncate font-mono text-2xs text-ink-faint hover:text-ink hover:underline"
                      title={row.report}
                    >
                      {row.report}
                    </a>
                  ) : (
                    <span className="min-w-0 flex-1 text-2xs text-ink-faint">no report file</span>
                  )}
                </li>
              ))}
            </ul>
            {rows.length > LIST_LIMIT && (
              <Button
                size="sm"
                variant="ghost"
                className="mt-2"
                onClick={() => setAll((was) => !was)}
                aria-expanded={all}
              >
                {all ? `Show the first ${LIST_LIMIT}` : `Show all ${rows.length}`}
              </Button>
            )}
          </>
        ) : (
          <Empty
            title="QA is off for this plan"
            body="QA subagents are opt-in. Nothing here means nothing was asked for — not that anything failed."
            action={
              <Button asChild size="sm">
                <a href={planHref(slug, 'source')}>Read the plan&rsquo;s QA line</a>
              </Button>
            }
          />
        )}
      </CardBody>
    </Card>
  );
}
