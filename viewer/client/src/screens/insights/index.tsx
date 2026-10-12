/**
 * Insights — what the record says, as questions (7.0, quiet-console phase 19;
 * one surface with a scope since 3.0).
 *
 * ```
 * Insights
 * Across 4 plans, as of 2 minutes ago.
 * [Every plan ⇅]                                                   Everything
 * How long is left
 *   12 sessions left, 1.4M of work across 3 open plans.
 *   Ready now 2   In flight 1
 * ─────────────────────────────────────────────────────────────────────────
 * What it costs
 *   Settled today   $18.25   what the runs cost
 *   ▬▬▬▬▬▬▬▬▬▬▬░░░░░░░░░░   $17.50 of ladder left today.
 * ─────────────────────────────────────────────────────────────────────────
 * …
 * ```
 *
 * Bare `#/insights` is the portfolio and `#/insights?plan=<slug>` one plan; the
 * retired `#/plan/:slug/analysis` lands here carrying its slug
 * (`LEGACY_PLAN_TABS`). Eleven questions, each answered once, top to bottom,
 * and none repeating another (two of them only have an answer when the page
 * is scoped):
 *
 *   **How long is left** (`eta`)                — the estimate and the basis under it
 *   **What it costs** (`cost-vs-caps`)          — the ladder against the day cap, each run against its budget
 *   **What each session cost** (`ledger-summary`) — the sessions' own figures, per plan and per account
 *   **What this plan cost** (`plan-cost`)       — per-phase money and a finish date (scoped only)
 *   **This plan’s record** (`plan-record`)      — its QA verdicts and their reports (scoped only)
 *   **What a session may spend** (`session-sizing`) — the caps, measured beside shipped; the context; sessions per phase
 *   **How fast** (`velocity`)                   — the median gap, the weekly trend and its texture
 *   **This week** (`week-report`)               — the acceptance targets judged on the week, and its measurements
 *   **Who was asked** (`approvals`)             — the cards raised for a person, and since when
 *   **What shape the work is in** (`portfolio`) — states, sizes, locks, health, stalled plans
 *   **On what** (`mix`)                         — repositories, skills, target models
 *
 * The order is deliberate: the two questions a person actually arrives with
 * are *when will this be done* and *what is it costing*, and both used to sit
 * below the fold under three charts. What a session may spend closes the
 * money; the past comes after.
 *
 * The scope is honest about what it narrows. `/api/stats` is a portfolio
 * aggregate with no per-plan breakdown, so a scoped page narrows what
 * genuinely IS one plan's — its estimate, its runs against their budgets, its
 * cost and its record — and says so under the toolbar, rather than
 * re-labelling a portfolio-wide figure with a plan's name.
 *
 * A question keeps its place while it is read: one whose answer has not
 * arrived holds a placeholder of about its answered height, marked
 * `aria-busy`, so an answer arriving late does not move the figures under the
 * reader's pointer (#247).
 */

import { useMemo, type ReactNode } from 'react';
import { useConsoleState } from '@/data/console';
import { usePlan, usePlans, useStats } from '@/data/plans';
import { useSessionSizing, useSpend } from '@/data/runs';
import { cn } from '@/lib/cn';
import { isClosed } from '@/lib/closure';
import { plural } from '@/lib/format';
import { insightsHref, navigate, type Route } from '@/shell/routes';
import { Button, Empty, Page, RelativeTime, Skeleton, useEverything } from '@/ui';
import { Combobox, type ComboboxOption } from '@/ui/combobox';
import { Toolbar } from '@/ui/toolbar';
import { ApprovalsPanel } from './approvals';
import { CostVsCapsPanel } from './cost-vs-caps';
import { EtaPanel } from './eta';
import { LedgerSummaryPanel } from './ledger-summary';
import { MixPanel } from './mix';
import { InsightSection, PROSE_LINK } from './parts';
import { PlanCostPanel } from './plan-cost';
import { PlanRecord } from './plan-record';
import { PortfolioPanel } from './portfolio';
import { SessionSizingPanel } from './session-sizing';
import { VelocityPanel } from './velocity';
import { WeekReportPanel } from './week-report';

/** The questions, by the id each section carries (`data-insight`), in the page's order. */
export const INSIGHT_QUESTIONS = Object.freeze([
  { id: 'eta', title: 'How long is left' },
  { id: 'cost', title: 'What it costs' },
  { id: 'ledger', title: 'What each session cost' },
  { id: 'plan-cost', title: 'What this plan cost' },
  { id: 'plan-record', title: 'This plan’s record' },
  { id: 'sizing', title: 'What a session may spend' },
  { id: 'velocity', title: 'How fast' },
  { id: 'week', title: 'This week' },
  { id: 'approvals', title: 'Who was asked' },
  { id: 'shape', title: 'What shape the work is in' },
  { id: 'mix', title: 'On what' },
] as const);

export type InsightId = (typeof INSIGHT_QUESTIONS)[number]['id'];

/** The questions only a scoped page asks. */
const SCOPED: ReadonlySet<InsightId> = new Set(['plan-cost', 'plan-record']);

/**
 * How tall each question stands while its answer is read — about its answered
 * height on a desk, so the questions under it are already where they will be.
 */
const PENDING_HEIGHT: Readonly<Record<InsightId, string>> = {
  eta: 'h-36',
  cost: 'h-96',
  ledger: 'h-28',
  'plan-cost': 'h-72',
  'plan-record': 'h-40',
  sizing: 'h-[30rem]',
  velocity: 'h-60',
  week: 'h-[38rem]',
  approvals: 'h-36',
  shape: 'h-[36rem]',
  mix: 'h-48',
};

/** The combobox's own value for "no plan": a slug is kebab-case, so it can never be this. */
const EVERY_PLAN = '*';

/** An error in the words its sender gave it. */
const said = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error ?? '')) || 'the read failed and said nothing.';

export default function Insights({ route }: { route: Route }) {
  const plan = route.query.plan || undefined;
  const everything = useEverything('insights');
  const statsQuery = useStats();
  const { data: state } = useConsoleState();
  const spendQuery = useSpend();
  const sizingQuery = useSessionSizing();
  const { data: plans } = usePlans();
  const detailQuery = usePlan(plan);

  const stats = statsQuery.data;
  // The last plan's answer stays on screen while the next one is read
  // (`keepPreviousData`), which on THIS page would print one plan's money
  // under another's name — so a placeholder answer counts as no answer.
  const detailPending = Boolean(plan) && (detailQuery.isPending || detailQuery.isPlaceholderData);
  const detail = plan && !detailPending ? detailQuery.data : undefined;
  const detailError = plan && !detailPending ? detailQuery.error : null;

  // Which slugs are closed, so an issue row can say so and stop offering a
  // repair the server would refuse anyway (`plan-repair` 409s on a closed
  // plan). The plans list rather than a new wire field: every other page has
  // already read it, so this is a cache read.
  const closedSlugs = useMemo(
    () => new Set((plans ?? []).filter((p) => isClosed(p)).map((p) => p.slug)),
    [plans],
  );

  const options = useMemo<ComboboxOption[]>(() => {
    const listed = (plans ?? []).map((p) => ({
      value: p.slug,
      label: p.slug,
      ...(p.title ? { keywords: [p.title] } : {}),
      ...(isClosed(p) ? { hint: 'closed' } : {}),
    }));
    // A scope the list does not hold — a slug typed into the address, or one
    // read before the list arrived — is still the scope, and still named.
    const missing =
      plan && !listed.some((option) => option.value === plan) ? [{ value: plan, label: plan }] : [];
    return [{ value: EVERY_PLAN, label: 'Every plan' }, ...missing, ...listed];
  }, [plans, plan]);

  /** The scope, one control: on the desk's bar itself, and in the View sheet on a phone. */
  const scope = (className: string) => (
    <Combobox
      options={options}
      value={plan ?? EVERY_PLAN}
      onChange={(next) => navigate(insightsHref(next && next !== EVERY_PLAN ? next : undefined))}
      label="Scope the page to a plan"
      searchPlaceholder="Find a plan…"
      emptyText="No plan has that name."
      className={className}
    />
  );

  if (statsQuery.error) {
    return (
      <Page title="Insights" data-testid="insights">
        <Empty
          title={`The portfolio could not be read: ${said(statsQuery.error)}`}
          action={
            <Button size="sm" onClick={() => void statsQuery.refetch()}>
              Try again
            </Button>
          }
        />
      </Page>
    );
  }

  const lead = stats ? (
    <>
      {plan
        ? `${plan}, one of ${plural(stats.totals.plans, 'plan')}`
        : `Across ${plural(stats.totals.plans, 'plan')}`}
      , as of <RelativeTime at={stats.generatedAt} />.
    </>
  ) : (
    'Reading every plan.'
  );

  /** A scoped question whose plan could not be read says so, with the way back. */
  const unreadable = detailError ? (
    <Empty
      title={`${plan} could not be read: ${said(detailError)}`}
      action={
        <Button size="sm" asChild>
          <a href={insightsHref()}>Show every plan</a>
        </Button>
      }
    />
  ) : null;

  const answers: Record<InsightId, { pending: boolean; answer: () => ReactNode }> = {
    eta: {
      pending: !stats || detailPending,
      answer: () => (
        <EtaPanel
          stats={stats!}
          plan={plan}
          planEta={plan ? (detail?.eta?.plan ?? null) : undefined}
          planStats={detail?.summary}
          everything={everything.on}
        />
      ),
    },
    cost: {
      pending: spendQuery.isPending,
      answer: () => <CostVsCapsPanel spend={spendQuery.data} plan={plan} everything={everything.on} />,
    },
    ledger: { pending: false, answer: () => <LedgerSummaryPanel everything={everything.on} /> },
    'plan-cost': {
      pending: detailPending,
      answer: () =>
        unreadable ?? (
          <PlanCostPanel
            slug={plan!}
            cost={detail?.cost}
            forecast={detail?.forecast}
            everything={everything.on}
          />
        ),
    },
    'plan-record': {
      pending: detailPending,
      answer: () => unreadable ?? <PlanRecord slug={plan!} qa={detail?.qa ?? []} />,
    },
    sizing: {
      pending: sizingQuery.isPending,
      answer: () => (
        <SessionSizingPanel
          sizing={sizingQuery.data}
          error={sizingQuery.error}
          onRetry={() => void sizingQuery.refetch()}
          everything={everything.on}
        />
      ),
    },
    velocity: { pending: !stats, answer: () => <VelocityPanel stats={stats!} /> },
    // The week reads its own answer, so its window and replay stay put while one is read.
    week: { pending: false, answer: () => <WeekReportPanel everything={everything.on} /> },
    approvals: { pending: !state, answer: () => <ApprovalsPanel counts={state?.approvals} /> },
    shape: {
      pending: !stats,
      answer: () => (
        <PortfolioPanel
          stats={stats!}
          allowWrites={state?.allowWrites === true}
          closedSlugs={closedSlugs}
          sizing={state?.sizing}
          plan={plan}
          everything={everything.on}
        />
      ),
    },
    mix: { pending: !stats, answer: () => <MixPanel stats={stats!} /> },
  };

  return (
    <Page title="Insights" lead={lead} data-testid="insights">
      <Toolbar
        label="Insights"
        filter={{
          label: 'Plan',
          value: plan ?? 'Every plan',
          active: plan ? 1 : 0,
          panel: scope('w-full'),
          inline: scope('w-56 max-w-full'),
        }}
        everything={everything}
        note={
          plan ? (
            <span className="max-w-(--measure)">
              The estimate, the runs, the cost and the record are {plan}’s; the rest is every plan’s.{' '}
              <a href={insightsHref()} className={PROSE_LINK}>
                Show every plan
              </a>
            </span>
          ) : undefined
        }
      />

      <div className="flex min-w-0 flex-col divide-y divide-rule" data-testid="insights-questions">
        {INSIGHT_QUESTIONS.filter((question) => plan || !SCOPED.has(question.id)).map((question) => {
          const { pending, answer } = answers[question.id];
          return (
            <InsightSection key={question.id} id={question.id} title={question.title}>
              {pending ? (
                <div aria-busy="true" className={cn('min-w-0', PENDING_HEIGHT[question.id])}>
                  <Skeleton className="size-full" />
                </div>
              ) : (
                answer()
              )}
            </InsightSection>
          );
        })}
      </div>
    </Page>
  );
}
