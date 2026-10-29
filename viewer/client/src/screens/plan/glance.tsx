/**
 * The plan's glance — the top of every view of `#/plan/:slug` (7.0,
 * quiet-console phase 10; design.md principles 1 and 2).
 *
 * What a person opening a plan asks first, in the order they ask it: which
 * plan, what it is doing, how far along the line it is, what is left and what
 * it cost — and the one thing to do about it. That act is the Runs home's own:
 * the plan's newest run placed in the same fold the home draws
 * (`useRunGroups`), its action decided by the same `rowModel` and drawn by
 * the same `RowActionButton`, so the plan page and the home can never offer
 * different moves for one run (#278). A plan with no run offers to start its
 * first ready phase, through the launch form's door.
 *
 * Everything else about the plan is a fold away ("About this plan") or in the
 * views below.
 */

import { useMemo, useState } from 'react';
import type { PlanDetail } from '@/data/api';
import { useConsoleState } from '@/data/console';
import { useAttentionInbox } from '@/data/inbox';
import { useLifecycle } from '@/data/lifecycle';
import { useRunGroups, type PlacedRun } from '@/data/run-groups';
import { useNow } from '@/ui/clock';
import { etaLabel, plural } from '@/lib/format';
import { Button, Money, Mono } from '@/ui';
import { LaunchDoor } from '@/screens/launch/door';
import { navigate, planHref, plansHref } from '@/shell/routes';
import { leftWords, toRows } from '@/screens/plans/model';
import { PlanLine, PlanMark } from '@/screens/plans/row';
import { WriteMenu } from '@/screens/plans/write-menu';
import { rowModel } from '@/screens/runs/model';
import { RowActionButton } from '@/screens/runs/row-action';

/** The plan's newest run, as the home placed it — or none. */
function usePlacedRun(slug: string, enabled: boolean): PlacedRun | null {
  const { model } = useRunGroups({ enabled, details: false });
  return useMemo(() => {
    let newest: PlacedRun | null = null;
    for (const placed of model.runs) {
      if (placed.run.slug !== slug) continue;
      if (!newest || (placed.run.createdAt ?? '') > (newest.run.createdAt ?? '')) newest = placed;
    }
    return newest;
  }, [model.runs, slug]);
}

export function PlanGlance({
  detail,
  titleAs: Title = 'h1',
  act = true,
}: {
  detail: PlanDetail;
  /** A phase or handoff page under the plan is that page's subject, and its own `h1`; the plan's name is then context. */
  titleAs?: 'h1' | 'p';
  /** The one act — off on the Run view, whose head carries the same act for the same run. */
  act?: boolean;
}) {
  const s = detail.summary;
  const { data: state } = useConsoleState();
  const allowRun = Boolean(state?.allowRun);
  const placed = usePlacedRun(s.slug, state != null && state.autopilot !== false);
  const { data: inbox } = useAttentionInbox();
  const row = useMemo(
    () => toRows([s], placed ? [placed.run] : [], Date.now(), inbox?.items ?? [])[0]!,
    [s, placed, inbox?.items],
  );
  const eta = detail.eta?.plan ?? s.eta ?? null;
  const left = leftWords(row);
  const spent = detail.cost?.totalUsd ?? 0;

  return (
    <header className="flex min-w-0 flex-col gap-3" data-testid="plan-glance">
      <a
        href={plansHref()}
        className="self-start text-meta text-ink-muted underline-offset-2 hover:text-ink hover:underline [@media(hover:none)]:min-h-(--tap-min)"
      >
        All plans
      </a>
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <Title className={row.isClosed ? 'min-w-0 text-title text-ink-muted' : 'min-w-0 text-title text-ink'}>
          {s.title}
        </Title>
        <WriteMenu detail={detail} allowWrites={Boolean(state?.allowWrites)} />
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <PlanMark row={row} size="md" />
        <Mono value={s.slug} />
      </div>
      <PlanLine row={row} className="w-full" />
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="min-w-0 text-body text-ink-muted" data-testid="plan-left">
          {/* A closed plan's words are what never ran — never "left". */}
          {row.isClosed || left === 'Nothing left' || left === 'Unknown' || left === 'No phases' ? (
            left
          ) : (
            <>{left} left</>
          )}
          {eta && !row.isClosed && !row.isComplete ? `, ${etaLabel(eta.lowMs, eta.highMs, eta.basis)}` : ''}
          {spent > 0 && (
            <>
              . <Money usd={spent} /> spent so far
            </>
          )}
          .
        </p>
        {act && <GlanceAct detail={detail} placed={placed} allowRun={allowRun} />}
      </div>
      <PlanMoney detail={detail} />
    </header>
  );
}

/**
 * Forecast against actual (measured-console phase 23, §Architecture 9 A6): what the verified
 * phases were forecast to cost beside what they did, the delta, every dollar per verified phase,
 * what failed attempts cost, and what the phases still open will likely cost. Every forecast
 * figure is `estimated`; nothing is drawn until a forecast or a verified phase exists.
 */
export function PlanMoney({ detail }: { detail: Pick<PlanDetail, 'cost' | 'forecastUsd' | 'phases'> }) {
  const a = detail.cost?.actuals;
  const open = new Set(detail.phases.filter((p) => p.state !== 'done').map((p) => p.phase));
  const left = (detail.forecastUsd?.phases ?? []).filter((f) => f.phase !== undefined && open.has(f.phase));
  const leftUsd = left.some((f) => f.usd !== null)
    ? Math.round(left.reduce((sum, f) => sum + (f.usd ?? 0), 0) * 100) / 100
    : null;
  if (!a?.verifiedPhases && !left.length) return null;
  return (
    // `leading-[1.125rem]` is the meta line (12.5 px × 1.45 = 18.125 px) snapped to a whole 18 px: the
    // paragraph wraps to two or three lines on a phone, and each fractional line would push every
    // control below it — the phases search above a keyboard — a quarter pixel off the pixel grid.
    <p className="min-w-0 text-meta leading-[1.125rem] text-ink-muted tnum" data-testid="plan-actuals">
      {a && a.forecastUsd !== null && a.forecastActualUsd !== null && a.deltaUsd !== null ? (
        <span data-testid="plan-actuals-delta">
          Forecast <Money usd={a.forecastUsd} word="estimated" showWord /> for{' '}
          {plural(a.forecastPhases, 'verified phase')}, actual <Money usd={a.forecastActualUsd} />
          {a.deltaUsd === 0 ? (
            ' — on the forecast'
          ) : (
            <>
              {' '}
              — <Money usd={Math.abs(a.deltaUsd)} /> {a.deltaUsd > 0 ? 'over' : 'under'}
              {a.deltaPct !== null ? ` (${Math.abs(a.deltaPct)} %)` : ''}
            </>
          )}
          .{' '}
        </span>
      ) : null}
      {a && a.costPerVerifiedPhaseUsd !== null ? (
        <span data-testid="plan-actuals-per-verified">
          <Money usd={a.costPerVerifiedPhaseUsd} /> per verified phase over{' '}
          {plural(a.verifiedPhases, 'phase')}, every attempt included.{' '}
        </span>
      ) : null}
      {a && a.verifiedPhases > 0 ? (
        <span data-testid="plan-actuals-failed">
          {a.failedAttempts ? (
            <>
              <Money usd={a.costOfFailedAttemptsUsd} /> on {plural(a.failedAttempts, 'failed attempt')}.{' '}
            </>
          ) : (
            'No failed attempt has cost anything. '
          )}
        </span>
      ) : null}
      {left.length ? (
        <span data-testid="plan-actuals-left">
          What is left will likely cost <Money usd={leftUsd} word="estimated" showWord /> over{' '}
          {plural(left.length, 'phase')}.
        </span>
      ) : null}
    </p>
  );
}

/** The ONE act — the newest run's, else starting the first ready phase. */
function GlanceAct({
  detail,
  placed,
  allowRun,
}: {
  detail: PlanDetail;
  placed: PlacedRun | null;
  allowRun: boolean;
}) {
  if (placed) return <RunAct placed={placed} allowRun={allowRun} />;
  return <StartAct detail={detail} allowRun={allowRun} />;
}

function RunAct({ placed, allowRun }: { placed: PlacedRun; allowRun: boolean }) {
  const now = useNow(true, 30_000);
  const model = useMemo(() => rowModel({ placed, now, allowRun }), [placed, now, allowRun]);
  const lifecycle = useLifecycle(placed.run.slug, undefined, { queued: placed.bay === 'queued' });
  return (
    <RowActionButton
      action={model.action}
      lifecycle={lifecycle}
      // A verb that needs words or a dialog asks for them on the run's halt card.
      onExpand={() => navigate(planHref(placed.run.slug, 'run'))}
    />
  );
}

function StartAct({ detail, allowRun }: { detail: PlanDetail; allowRun: boolean }) {
  const [launching, setLaunching] = useState(false);
  const s = detail.summary;
  const first = s.ready[0];
  if (!allowRun || first == null || s.status === 'complete' || detail.summary.closed) return null;
  const phase = detail.phases.find((p) => p.phase === first);
  return (
    <>
      <Button
        size="sm"
        variant="primary"
        className="h-auto shrink whitespace-normal max-sm:w-full"
        data-testid="glance-start"
        title={`Start phase ${first} — the launch form asks how`}
        onClick={() => setLaunching(true)}
      >
        Start phase {first}
      </Button>
      {launching && (
        <LaunchDoor
          request={{
            kind: 'phase',
            slug: s.slug,
            phase: first,
            run: null,
            ...(phase?.lock ? { lock: phase.lock } : {}),
            ...(s.qaMode ? { qaMode: s.qaMode } : {}),
            ...(detail.plan?.sessionBudget?.skills?.length
              ? { planSkills: detail.plan.sessionBudget.skills }
              : {}),
            ...(detail.plan?.reviewers?.length ? { planReviewers: detail.plan.reviewers } : {}),
          }}
          onClose={() => setLaunching(false)}
        />
      )}
    </>
  );
}
