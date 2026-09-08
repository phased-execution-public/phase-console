/**
 * The header strip, and the plans in flight.
 *
 * ## The strip
 *
 * Six facts on one line: which project, how many lanes are running, how many
 * things need a person, how many are queued, what today has cost against the
 * day cap, and what proportion of the portfolio is done. It is the answer to
 * "should I be looking at this at all", and it sits above everything so that
 * answer costs no scrolling.
 *
 * **Spend today is the CAP's own arithmetic**, from `GET /api/spend` —
 * settled runs plus what the ladder spent, against `ladderPerDayUsd`. It is
 * deliberately not "the sum of what the runs on screen have spent": those are
 * different numbers (measured live on the Runs page at $3,175.78 against
 * $76.17), and only this one is what the ladder refuses against. A console
 * with no cap set shows the figure without a bar, because a meter with no
 * ceiling is a bar that means nothing.
 *
 * ## The strips
 *
 * One line of track per open, unfinished plan, most recently active first —
 * the shape of the portfolio rather than a count of it. A strip needs per-phase
 * state, which is one engine read per plan, so the section takes the few most
 * active and says so; those reads are shared with the plan page's cache, which
 * is what makes opening one of these instant.
 */

import { ArrowRight } from 'lucide-react';
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  InfoTip,
  Meter,
  RelativeTime,
  Skeleton,
  TooltipProvider,
} from '@/components/ui';
import { RouteStrip } from '@/components/charts';
import { plainText } from '@/lib/plain-text';
import { etaLabel, etaTitle, money, plural } from '@/lib/format';
import { phaseHref, planHref } from '@shared/routes.js';
import { plansHref } from '@/app/routes';
import { overDayCap } from '@shared/ladder-model.js';
import type { PlanDetail, PlanSummaryFull, SpendView } from '@/lib/api';
import { useFocusBand } from './focus-band';

export interface PortfolioStripProps {
  /** The instance's own label, and the branch it is reading. */
  project?: string;
  branch?: string;
  running: number;
  needsYou: number;
  queued: number;
  ready: number;
  spend: SpendView | undefined;
  /** Portfolio completion, as the engine already computed it. */
  percent?: number;
}

export function HeaderStrip({
  project,
  branch,
  running,
  needsYou,
  queued,
  ready,
  spend,
  percent,
}: PortfolioStripProps) {
  const today = spend?.today;
  // Two numbers, not one. `spent` is what the day cost; `ladder` is the only
  // half the day cap gates, and comparing the sum against it made a normal
  // day read as "at the cap" (`overDayCap`, shared/ladder-model.js).
  const spent = (today?.settledUsd ?? 0) + (today?.ladderUsd ?? 0);
  const ladder = today?.ladderUsd ?? 0;
  const cap = today?.capUsd ?? null;
  const atCap = today ? overDayCap(today) : false;

  return (
    // Its own tooltip provider, the way `components/recovery-actions.tsx` has
    // one: the strip is the first thing on the default route and several
    // harnesses mount a destination without the app shell. Nesting under the
    // app's own provider is fine.
    <TooltipProvider delayDuration={300}>
      <section
        aria-label="Right now"
        data-testid="header-strip"
        className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-rule bg-surface px-3 py-2"
      >
        <span className="min-w-0 flex-1 basis-full truncate sm:basis-auto">
          <span className="font-display text-lg leading-none">{project ?? 'This console'}</span>
          {branch && <span className="ml-2 font-mono text-2xs text-ink-faint">{branch}</span>}
        </span>

        <Fact label="running" value={running} tone={running > 0 ? 'live' : 'neutral'} />
        <Fact label="need you" value={needsYou} tone={needsYou > 0 ? 'accent' : 'neutral'} />
        <Fact label="queued" value={queued} tone={queued > 0 ? 'wait' : 'neutral'} />
        <Fact label="ready" value={ready} tone="neutral" />

        {/*
         * `min-w-0`, and it replaced `min-w-40` for the reason `min-w-0` exists.
         *
         * A flex item's default `min-width: auto` is "never smaller than my
         * content". Naming any other number REPLACES that floor, so `min-w-40`
         * did not reserve 160px — it granted permission to be 160px while the
         * content stayed 334: the money text was `shrink-0` at 218px and the
         * meter carries its own 80px floor, and neither can give. Everything
         * past the group's box simply painted onward, over the `% of
         * everything` fact at 1440 and 23px past `<main>`'s clip edge at 360.
         *
         * `min-w-0` is the honest floor for a group whose content CAN reflow,
         * and the two changes below are what make that true: the money text
         * wraps at its own separators instead of refusing, and `basis-full`
         * gives the group its own line on a phone, exactly as the project name
         * above already takes one.
         */}
        <span className="flex min-w-0 flex-1 basis-full items-center gap-2 sm:basis-auto">
          <span className="min-w-0 font-mono text-2xs tabular-nums text-ink-muted">
            {money(spent)}
            {cap != null ? ` · ${money(ladder)} / ${money(cap)}` : ''}
          </span>
          {/* Three unlabelled money figures, and which of them the cap actually
            refuses against is the whole point of the row. That was a `title`,
            which a phone never shows — and this strip is the first thing a
            phone opens. `InfoTip` is the touch path. */}
          <InfoTip
            label="What today's figures mean"
            content={
              <>
                {money(spent)} spent today — {money(ladder)} of it the ladder&rsquo;s, which is the half the
                day cap gates.
              </>
            }
          />
          {cap != null && cap > 0 ? (
            // `max` is the cap itself, not a pre-divided fraction: `Meter` clamps
            // the painted share and turns `over` on its own, so the one place
            // that knows "past the ceiling" is the primitive rather than three
            // callers with three thresholds.
            //
            // `value` is the LADDER's spend, not the day's: `ladderPerDayUsd`
            // refuses a rung on that number alone (`overDayCap`).
            <Meter
              value={ladder}
              max={cap}
              label="ladder spend today against the day cap"
              valueText={`${money(ladder)} of ${money(cap)}`}
              tone={atCap || ladder > cap * 0.8 ? 'waiting' : 'running'}
              className="min-w-20 flex-1"
            />
          ) : (
            <span className="text-2xs text-ink-faint" title="No ladderPerDayUsd is set on this console.">
              spent today · no cap
            </span>
          )}
        </span>

        {percent != null && (
          <span
            className="shrink-0 font-mono text-2xs tabular-nums text-ink-faint"
            title="Of every phase of every plan, closed ones included."
          >
            {percent}% of everything
          </span>
        )}
      </section>
    </TooltipProvider>
  );
}

function Fact({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'live' | 'accent' | 'wait' | 'neutral';
}) {
  return (
    <span className="flex shrink-0 items-baseline gap-1">
      <Badge tone={tone} mono>
        {value}
      </Badge>
      <span className="text-2xs text-ink-faint">{label}</span>
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * Plans in flight
 * ------------------------------------------------------------------ */

export function PlansInFlight({
  plans,
  details,
  loading,
  focused = false,
}: {
  plans: PlanSummaryFull[];
  details: Map<string, PlanDetail>;
  loading: boolean;
  /** `?focus=plans` landed here. */
  focused?: boolean;
}) {
  const bandRef = useFocusBand<HTMLDivElement>(focused);

  return (
    <Card ref={bandRef} data-testid="plans-in-flight" {...(focused ? { 'data-focused': 'true' } : {})}>
      <CardHeader className="flex-wrap items-baseline gap-x-3 gap-y-1">
        <CardTitle>Plans in flight</CardTitle>
        <a
          href={plansHref()}
          className="flex shrink-0 items-center gap-1 text-2xs text-ink-faint hover:text-action"
        >
          every plan <ArrowRight size={11} aria-hidden />
        </a>
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        {plans.length === 0 && (
          <p className="text-sm text-ink-faint">
            {loading ? 'Reading the plans…' : 'No plan has unfinished phases.'}
          </p>
        )}

        {plans.map((plan) => {
          const detail = details.get(plan.slug);
          const nodes = detail?.route?.nodes ?? [];
          const ready = plan.ready ?? [];

          return (
            <div key={plan.slug} className="min-w-0">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                <a
                  href={planHref(plan.slug)}
                  className="min-w-0 flex-1 truncate text-md hover:text-action"
                  title={plainText(plan.title || plan.slug)}
                >
                  {plainText(plan.title || plan.slug)}
                </a>
                {/* `min-w-0`, not `shrink-0`. The ETA phrase makes this row a
                    variable length — `3/9 · 33%` is 60 px and
                    `3/9 · 33% · ~1.5 h–5 h (from other plans)` is 295 — and
                    `shrink-0` on a variable-length row is what makes it push
                    the page instead of wrapping. Measured at 320: it ran to
                    324.3 and the shell scrolled sideways by 4 px. Same defect
                    class as Phase 10's session strip and the run console's
                    action row. */}
                <span className="min-w-0 font-mono text-2xs break-words tabular-nums text-ink-faint">
                  {plan.done}/{plan.phases} · {plan.percent}%
                  {/* A `title` and no `InfoTip`, unlike the spend figures above,
                      and deliberately: `etaLabel` already prints the hedge and
                      the basis on screen (`~1.5 h–5 h (from other plans)`), so
                      the hover is evidence for a number nothing is decided
                      from. Six rows, six ⓘ buttons, for a footnote — that is
                      the blanket-wrap this pattern is not for. */}
                  {plan.eta && (
                    <span title={etaTitle(plan.eta)}>
                      {' · '}
                      {etaLabel(plan.eta.lowMs, plan.eta.highMs, plan.eta.basis)}
                    </span>
                  )}
                </span>
              </div>

              <div className="mt-1.5 flex items-center gap-2">
                {nodes.length > 0 ? (
                  // `aria-label`, not `title`: a title is a desktop hover and a
                  // phone never shows one, so a link whose ONLY name is a
                  // title has no name at all on the surface this band was
                  // designed for. The strip inside is `role="img"` with its own
                  // summary, so without this the link would announce as that
                  // summary — "8 phases, 5 done" — which says nothing about
                  // where pressing it goes.
                  <a
                    href={planHref(plan.slug)}
                    className="min-w-0 flex-1"
                    aria-label={`Open ${plan.slug}'s route map`}
                  >
                    {/* `tally={false}`: this card already prints `5/8 · 62%`
                        directly above the strip and the ready phases directly
                        below it, so the strip's own counts would be the third
                        telling of the same row. */}
                    <RouteStrip phases={[...nodes].sort((a, b) => a.phase - b.phase)} tally={false} />
                  </a>
                ) : (
                  <Skeleton className="h-3 flex-1" />
                )}
              </div>

              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                {ready.length > 0 ? (
                  ready.map((phase) => (
                    <a key={phase} href={phaseHref(plan.slug, phase)} className="rounded-sm">
                      <Badge tone="state" dot mono className="state-ready hover:bg-action/12">
                        P{phase} ready
                      </Badge>
                    </a>
                  ))
                ) : (
                  <span className="text-2xs text-ink-faint">
                    {plan.inProgress?.length
                      ? `phase ${plan.inProgress.join(', ')} in progress`
                      : 'nothing ready — every remaining phase is waiting on another'}
                  </span>
                )}
                {/* `live={false}`: six of these, none of whose clocks moves
                    without a refetch that repaints the row anyway. */}
                <RelativeTime
                  at={plan.activity}
                  live={false}
                  className="ml-auto shrink-0 text-2xs text-ink-faint"
                />
              </div>
            </div>
          );
        })}

        {plans.length > 0 && (
          <p className="text-2xs text-ink-faint">
            The {plural(plans.length, 'most recently active plan')} — every other open plan is on{' '}
            <a href={plansHref()} className="hover:text-action">
              Plans
            </a>
            .
          </p>
        )}
      </CardBody>
    </Card>
  );
}
