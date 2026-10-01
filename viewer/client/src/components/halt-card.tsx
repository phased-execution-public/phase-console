/**
 * Why a run stopped — ONE card, on every surface that says so.
 *
 * A stop used to be explained four times: the status strip printed the halt's
 * reason, Ways forward derived prose of its own, the errand card quoted the
 * ladder, and the inbox row quoted the server. Each was true; none said what
 * KIND of stop it was, and none put the fix beside the cause. This card is
 * the one rendering, built from `haltView()` (`shared/halt-categories.js`):
 *
 *   1. the family, as a quiet mark — one of nine words;
 *   2. ONE sentence saying what happened, in the reader's words;
 *   3. the fix the family usually wants, and the controls that make it —
 *      a budget's raise, the streak's clear, a plan's reader, a park's holders;
 *   4. the recommended button, which is `recoveryActionsFor(ctx)[0]` — the
 *      recovery model's own first verb, drawn first by `RecoveryActions`;
 *   5. one press away: the runner's words verbatim, the ladder, what it
 *      tried, the caps, the watch refs (live or refused) and the verdict's tree.
 *
 * `variant="row"` is the same card folded to a line — family, sentence and
 * the recommended button — for lists that link to the full one.
 *
 * Only this file renders `halt.reason` (`features/runs/single-source.test.ts`
 * scans for anyone else who does).
 */

import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';

import { HALT_CATEGORY_FIX, HALT_CATEGORY_LABELS, type HolderView } from '@shared/halt-categories.js';
import { haltView, type HaltView } from '@shared/halt-view.js';
import {
  USD_RAISE_STEP,
  WAIT_RAISE_STEPS_MIN,
  budgetAmount,
  budgetHeadline,
  type BudgetFact,
} from '@shared/budget-model.js';
import { protectedPathOf } from '@shared/situation-model.js';
import { phaseHref, planHref } from '@shared/routes.js';
import { Button, Input, RelativeTime } from '@/components/ui';
import { HaltCategoryMark, capArithmetic } from '@/components/halt-mark';
import { LadderStrip } from '@/components/errand';
import { Markdown } from '@/components/markdown';
import { RecoveryActions } from '@/components/recovery-actions';
import { api, type Errand, type PhaseRecord, type RunState } from '@/lib/api';
import { keys, toastError, useApiMutation, useConsoleState } from '@/lib/queries';
import { ladderView } from '@/lib/ladder';
import { runRecoverVerb, type RunRecoverVerb } from '@/lib/run-recover';
import { settingsHref } from '@/app/routes';
import { cn } from '@/lib/cn';
import { TreeLine } from '@/components/verify-tree';

/* ------------------------------------------------------------------ *
 * The fix controls
 * ------------------------------------------------------------------ */

/** The rungs one press adds to a spent recovery cap. */
const LADDER_RAISE_STEP = 4;

/**
 * The raise beside the reason (control-tower phase 14, #40): +30m or +60m for
 * a wait, a dollar step for a cost cap, rungs for the recovery ladder, or any
 * amount typed. The console writes it where it was declared — the plan's
 * `Waits on:` for a wait, the run's setting for the rest — and retries. A wait
 * writes the PLAN, so a console without `--allow-writes` says why it cannot.
 * The streak is never raised: its control is Clear the streak.
 */
export function BudgetRaise({ slug, phase, fact }: { slug: string; phase: number | null; fact: BudgetFact }) {
  const { data: state } = useConsoleState();
  const [busy, setBusy] = useState(false);
  const [custom, setCustom] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The streak is cleared, and a spent COUNT of declared waits is re-opened by
  // the phase's own Retry — neither is a number a raise can move. Said here,
  // before the press, rather than discovered after it.
  if (fact.budget === 'streak') return null;
  if (fact.unit === 'waits') {
    return (
      <p className="text-2xs text-ink-muted" data-testid="budget-waits">
        The count of declared waits is not raised: this phase’s Retry opens it again.
      </p>
    );
  }
  const writable = fact.budget !== 'wait' || Boolean(state?.allowWrites);
  const steps: readonly number[] =
    fact.budget === 'wait'
      ? WAIT_RAISE_STEPS_MIN
      : fact.unit === 'usd'
        ? [USD_RAISE_STEP]
        : [LADDER_RAISE_STEP];
  const unitWord = fact.unit === 'minutes' ? 'minutes' : fact.unit === 'usd' ? 'dollars' : 'rungs';
  const typed = Number(custom);
  const amount = (n: number) => budgetAmount(fact.budget, n, fact.unit);
  const raise = (add: number) => {
    setBusy(true);
    setError(null);
    api
      .runRaiseBudget(slug, { budget: fact.budget, ...(phase != null ? { phase } : {}), add })
      .then((answer) =>
        setDone(
          `Raised ${amount(answer.was)} → ${amount(answer.now)}` +
            (answer.retried ? ' and retried.' : '. Continue the run when you are ready.'),
        ),
      )
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  };
  if (done) return <p className="text-2xs text-ink-muted">{done}</p>;
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="budget-raise">
      {steps.map((add) => (
        <Button key={add} size="sm" disabled={busy || !writable} onClick={() => raise(add)}>
          +{amount(add)}
        </Button>
      ))}
      <Input
        type="number"
        min={1}
        inputMode="decimal"
        value={custom}
        onChange={(event) => setCustom(event.target.value)}
        placeholder={unitWord}
        aria-label={`Raise by, in ${unitWord}`}
        className="h-7 w-24 text-2xs"
        disabled={busy || !writable}
      />
      <Button
        size="sm"
        variant="ghost"
        disabled={busy || !writable || !(typed > 0)}
        onClick={() => raise(typed)}
      >
        {busy ? 'Raising…' : 'Raise and retry'}
      </Button>
      {!writable && (
        <span className="text-2xs text-ink-muted">
          A wait budget is written to the plan — start the console with --allow-writes to raise it here.
        </span>
      )}
      {error && <span className="text-2xs text-failed">{error}</span>}
    </div>
  );
}

/**
 * The streak as `n of max`, with the one control that zeroes it (#37): a run
 * could stop on `failure-streak` at 3 of a maximum 2 with nothing anywhere
 * that cleared the count — Retry clears it only as a side effect of retrying
 * a phase, the wrong shape when the failures were an outage.
 */
export function StreakLine({ slug, count, max }: { slug: string; count: number; max: number }) {
  const [clearing, setClearing] = useState(false);
  const [cleared, setCleared] = useState<number | null>(null);
  if (cleared !== null) {
    return <p className="text-2xs text-ink-muted">Cleared — the count was {cleared}.</p>;
  }
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="halt-streak">
      <span className="text-2xs text-ink-muted">
        <span className="font-mono text-ink">
          {count}/{max || '—'}
        </span>{' '}
        phases failed in a row
        {max > 0 && count >= max ? ' — the run stops here until this is cleared.' : '.'}
      </span>
      <Button
        size="sm"
        variant="ghost"
        disabled={clearing}
        onClick={() => {
          setClearing(true);
          api
            .runClearStreak(slug)
            .then((answer) => setCleared(answer.was))
            .catch(toastError)
            .finally(() => setClearing(false));
        }}
      >
        {clearing ? 'Clearing…' : 'Clear the streak'}
      </Button>
    </div>
  );
}

/** Every account the breaker knows is unusable, so there is nothing to switch to (#35). */
function AccountsBanner({ unusable, total }: { unusable: number; total: number }) {
  return (
    <p data-testid="halt-accounts" className="max-w-prose text-2xs text-ink-muted">
      <span className="font-medium text-ink">Every Claude account registered here is unusable</span> (
      {unusable} of {total}). No run can start until one is cleared or another is signed in, under{' '}
      <a className="underline underline-offset-2" href={settingsHref('accounts')}>
        Settings ▸ Accounts
      </a>
      .
    </p>
  );
}

/** What a credential refusal stood on (#57): the source, the words, and whose stop it was. */
function EvidenceLine({ evidence }: { evidence: NonNullable<HaltView['evidence']> }) {
  const where = [
    evidence.slug,
    evidence.phase != null ? `phase ${evidence.phase}` : null,
    evidence.session ? `session ${evidence.session.slice(0, 8)}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <p data-testid="halt-evidence" className="max-w-prose text-2xs text-ink-muted">
      <span className="font-medium text-ink">
        {evidence.source === 'api' ? 'The API returned' : 'The API-error channel said'}
      </span>{' '}
      “{evidence.matched}”{where ? ` — ${where}` : ''}.
    </p>
  );
}

/** The one action a holder offers: a press the console runs, or the door a person opens. */
function HolderAction({ slug, holder }: { slug: string; holder: HolderView }) {
  const [busy, setBusy] = useState(false);
  const press = holder.action.press as RunRecoverVerb | null;
  if (!press) {
    const href = holder.verb === 'settings' ? planHref(slug, 'run') : phaseHref(slug, holder.phase);
    return (
      <Button size="sm" variant="ghost" asChild data-testid="halt-holder-action">
        <a href={href}>{holder.action.label}</a>
      </Button>
    );
  }
  return (
    <Button
      size="sm"
      data-testid="halt-holder-action"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void runRecoverVerb(press, { slug, phase: holder.phase }).finally(() => setBusy(false));
      }}
    >
      {busy ? 'Working…' : holder.action.label}
    </Button>
  );
}

/** A `nothing-ready` park, unpacked: one row per holder, each with its own action. */
function HolderList({ slug, holders }: { slug: string; holders: HolderView[] }) {
  return (
    <ul data-testid="halt-holders" className="flex flex-col gap-1.5">
      {holders.map((holder) => (
        <li
          key={holder.phase}
          data-testid="halt-holder"
          data-holder-kind={holder.kind}
          className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-rule pt-1.5 first:border-t-0 first:pt-0"
        >
          <span className="font-mono text-2xs text-ink-muted">P{holder.phase}</span>
          <HaltCategoryMark category={holder.category} />
          <span className="text-2xs text-ink">{holder.automatic ? 'Automatic gate' : holder.label}</span>
          <span className="min-w-0 basis-full text-2xs text-ink-muted sm:basis-auto sm:flex-1">
            {holder.why}
            {holder.setting ? ` (raised by ${holder.setting})` : ''}
            {holder.chain && holder.chain.length > 0 && (
              // The blocker behind the blocker (#150 ask 4): each link, and what
              // the last one still has to do.
              <span className="block font-mono text-ink" data-testid="halt-chain">
                {holder.chain
                  .map(
                    (link) =>
                      link.label +
                      (link.phasesLeft != null ? ` (${link.phasesLeft} phases left` : '') +
                      (link.phasesLeft != null && link.eta
                        ? `, ETA ${link.eta})`
                        : link.phasesLeft != null
                          ? ')'
                          : '') +
                      (link.phasesLeft == null && link.eta ? ` (ETA ${link.eta})` : ''),
                  )
                  .join(' → ')}
              </span>
            )}
          </span>
          <HolderAction slug={slug} holder={holder} />
        </li>
      ))}
    </ul>
  );
}

/**
 * The plan a plan-mode phase presented, READ — not a byte count (#34). A
 * person cannot approve a plan they were only told the size of.
 */
export function PlanReader({ slug, phase }: { slug: string; phase: number }) {
  const [reason, setReason] = useState('');
  const plan = useQuery({
    queryKey: [...keys.run(slug), 'plan-text', phase],
    queryFn: () => api.runPlanText(slug, phase),
    retry: false,
  });
  const decide = useApiMutation({
    fn: (decision: 'approve' | 'reject') =>
      api.runPlanDecision(slug, { phase, decision, ...(reason.trim() ? { reason: reason.trim() } : {}) }),
    say: (answer) =>
      answer.decision === 'approve'
        ? 'Approved — the phase carries on.'
        : 'Rejected — the phase stays parked.',
    invalidates: [keys.run(slug)],
  });
  return (
    <div data-testid="plan-reader" className="flex flex-col gap-2">
      {plan.isPending ? (
        <p className="text-2xs text-ink-muted">Reading the plan…</p>
      ) : plan.isError ? (
        <p className="text-2xs text-ink-muted">
          The plan it presented could not be read:{' '}
          {plan.error instanceof Error ? plan.error.message : 'unknown'}.
        </p>
      ) : (
        <>
          <div className="max-h-96 overflow-auto rounded border border-rule bg-ground px-3 py-2 text-sm">
            <Markdown text={plan.data.text} />
          </div>
          {plan.data.truncated && (
            <p className="text-2xs text-ink-muted">
              The plan was longer than the console keeps; this is its beginning.
            </p>
          )}
          {plan.data.state === 'pending' ? (
            <div className="flex flex-col gap-1.5">
              <Input
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Why, if you reject it (the session is told)"
                aria-label="Why"
                className="h-8 max-w-xl text-2xs"
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="action"
                  disabled={decide.isPending}
                  onClick={() => decide.mutate('approve')}
                >
                  Approve the plan
                </Button>
                <Button size="sm" disabled={decide.isPending} onClick={() => decide.mutate('reject')}>
                  Reject the plan
                </Button>
              </div>
            </div>
          ) : (
            <p className="text-2xs text-ink-muted">This plan was {plan.data.state} already.</p>
          )}
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * The details — one press away
 * ------------------------------------------------------------------ */

function WatchRefs({ record }: { record: PhaseRecord | undefined }) {
  const refs = record?.watchState?.refs ?? [];
  const unpollable = record?.watchUnpollable ?? [];
  if (!refs.length && !unpollable.length && !record?.watch?.length) return null;
  const asked = new Set(refs.map((r) => r.ref));
  return (
    <div data-testid="halt-watch" className="flex flex-col gap-0.5">
      <span className="text-2xs font-medium text-ink">What it watches</span>
      <ul className="flex flex-col gap-0.5 text-2xs text-ink-muted">
        {refs.map((r) => (
          <li key={r.ref} data-watch-state={r.state === 'refused' ? 'refused' : 'live'}>
            <span className="font-mono">{r.ref}</span> — {r.state === 'refused' ? 'refused' : r.state}
            {r.detail ? `: ${r.detail}` : ''}
          </li>
        ))}
        {(record?.watch ?? [])
          .filter((ref) => !asked.has(ref) && !unpollable.some((u) => u.ref === ref))
          .map((ref) => (
            <li key={ref} data-watch-state="live">
              <span className="font-mono">{ref}</span> — not asked yet
            </li>
          ))}
        {unpollable.map((u) => (
          <li key={u.ref} data-watch-state="refused">
            <span className="font-mono">{u.ref}</span> — refused: {u.reason}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The verdict's commands, each with the tree it ran against (#41); a rescued one drawn green beside its red. */
function VerifyTree({ record }: { record: PhaseRecord | undefined }) {
  const ran = record?.verification?.ran ?? [];
  if (!ran.length) return null;
  return (
    <div data-testid="halt-verify" className="flex flex-col gap-0.5">
      <span className="text-2xs font-medium text-ink">What the verification ran</span>
      <ul className="flex flex-col gap-0.5 text-2xs text-ink-muted">
        {ran.map((run, index) => (
          <li key={`${run.command}-${index}`} data-verify-ok={run.ok ? 'yes' : 'no'}>
            <span className={run.ok ? 'text-done' : 'text-failed'}>
              {run.ok ? 'green' : `red (${run.code})`}
            </span>
            {run.retry ? (run.ok ? ' — rescued on its retry' : ' — red again on its retry') : ''}{' '}
            <span className="font-mono">{run.command}</span>
            {run.tree && <TreeLine tree={run.tree} testId="halt-tree" className="text-ink-muted" />}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Details({
  view,
  run,
  record,
  errand,
}: {
  view: HaltView;
  run: RunState;
  record: PhaseRecord | undefined;
  errand: Errand | null;
}) {
  const ladder = ladderView({
    run,
    phase: view.phase ?? undefined,
    record: record?.situation ? { situation: { key: record.situation.key } } : null,
  });
  const cap = errand ? capArithmetic(errand) : null;
  return (
    <div
      data-testid="halt-details"
      className="flex flex-col gap-2 rounded border border-rule bg-ground px-3 py-2"
    >
      <div>
        <span className="text-2xs font-medium text-ink">What the runner wrote</span>
        <p data-testid="halt-reason" className="max-w-prose whitespace-pre-wrap text-2xs text-ink-muted">
          {view.reason ?? 'Nothing — this stop was written without a reason.'}
        </p>
      </div>
      <LadderStrip view={ladder} />
      {errand && errand.tried.length > 0 && (
        <p data-testid="halt-tried" className="max-w-prose text-2xs text-ink-muted">
          Tried by the autopilot: {errand.tried.join(' · ')}
        </p>
      )}
      {cap && (
        <p data-testid="halt-cap" className="max-w-prose text-2xs text-ink-muted">
          {cap}
        </p>
      )}
      <WatchRefs record={record} />
      <VerifyTree record={record} />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * The card
 * ------------------------------------------------------------------ */

export type HaltCardProps = {
  run: RunState;
  /** `row` folds the card to a line: family, sentence, the recommended button. */
  variant?: 'full' | 'row';
  /** The run is live again: the stop is history, and nothing is offered for it. */
  live?: boolean;
  authFailure?: boolean;
  /** What the recovery verbs are about, when the page knows more than the halt. */
  target?: { slug: string; phase?: number; runId?: string };
  /** Controls a page adds beside the fix (the identity park's two ways on). */
  children?: ReactNode;
  className?: string;
};

/**
 * The card folded to a line — the family, the sentence and the recommended
 * button — for a list that links to the full card. Its own component so a
 * page that draws only the line never reaches the full card's details.
 */
export function HaltRow({
  run,
  live = false,
  authFailure = false,
  target,
  className,
}: Omit<HaltCardProps, 'variant' | 'children'>) {
  const view = haltView(run, authFailure ? { authFailure: true } : {});
  if (!view) return null;
  const recoveryTarget = target ?? {
    slug: run.slug,
    ...(view.phase != null ? { phase: view.phase } : {}),
    ...(run.id ? { runId: run.id } : {}),
  };
  return (
    <div
      data-testid="halt-row"
      data-halt-category={view.category}
      className={cn('flex flex-wrap items-center gap-x-2 gap-y-1', className)}
    >
      <HaltCategoryMark category={view.category} />
      <span className="min-w-0 flex-1 text-2xs text-ink" data-testid="halt-sentence">
        {view.sentence}
        {view.phase != null && <span className="text-ink-muted"> (phase {view.phase})</span>}
      </span>
      {!live && (
        <RecoveryActions
          target={recoveryTarget}
          ctx={{ ...view.ctx, run }}
          max={1}
          bare
          leadTestId="halt-recommended"
        />
      )}
    </div>
  );
}

export function HaltCard({
  run,
  variant = 'full',
  live = false,
  authFailure = false,
  target,
  children,
  className,
}: HaltCardProps) {
  const [open, setOpen] = useState(false);
  const view = haltView(run, authFailure ? { authFailure: true } : {});
  if (!view) return null;
  const recordFor = view.phase != null ? run.phases?.[String(view.phase)] : undefined;
  const errand = (view.errand as Errand | null) ?? null;
  const recoveryTarget = target ?? {
    slug: run.slug,
    ...(view.phase != null ? { phase: view.phase } : {}),
    ...(run.id ? { runId: run.id } : {}),
  };

  if (variant === 'row') {
    return (
      <HaltRow
        run={run}
        live={live}
        authFailure={authFailure}
        {...(target ? { target } : {})}
        {...(className ? { className } : {})}
      />
    );
  }

  const protectedPath =
    view.situation.endsWith(':protected-path') || errand?.situation === 'blocked-declared:protected-path'
      ? protectedPathOf(errand?.said, errand?.need, view.reason, recordFor?.note)
      : undefined;
  const refs = recordFor?.watchState?.refs ?? [];
  const allRefused =
    (refs.length > 0 || (recordFor?.watchUnpollable?.length ?? 0) > 0) &&
    refs.every((r) => r.state === 'refused');
  const tree = recordFor?.verification?.ran?.find((r) => !r.ok && r.tree)?.tree;
  const budget = view.budget && view.budget.budget !== 'streak' ? (view.budget as BudgetFact) : null;

  return (
    <section
      data-testid="halt-card"
      data-halt-category={view.category}
      data-halt-kind={view.kind ?? 'unknown'}
      aria-label={`Why this stopped: ${HALT_CATEGORY_LABELS[view.category]}`}
      className={cn('flex flex-col gap-2', className)}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <HaltCategoryMark category={view.category} />
        <span className="text-2xs text-ink-muted">
          {run.slug}
          {view.phase != null ? ` · phase ${view.phase}` : ''}
        </span>
        {view.at && <RelativeTime at={view.at} className="text-2xs text-ink-muted" />}
      </div>
      {live && (
        <p className="text-2xs text-ink-muted">The console picked this run back up. What stopped it:</p>
      )}
      <p data-testid="halt-sentence" className="max-w-prose text-base font-medium text-ink">
        {budget ? budgetHeadline(budget, 'spent') : view.sentence}
      </p>
      {!live && (
        <p data-testid="halt-fix" className="max-w-prose text-2xs text-ink-muted">
          {HALT_CATEGORY_FIX[view.category]}
        </p>
      )}

      {!live && (
        <div className="flex flex-col gap-2">
          {budget && <BudgetRaise slug={run.slug} phase={view.phase} fact={budget} />}
          {view.streak && <StreakLine slug={run.slug} count={view.streak.count} max={view.streak.max} />}
          {view.roots.length > 0 && (
            <ul data-testid="halt-roots" className="flex flex-col gap-0.5 text-2xs text-ink-muted">
              {view.roots.map((root) => (
                <li key={root.key}>
                  <span className="text-ink">{root.label}</span> — one cause, charged once, which stopped
                  phase
                  {root.phases.length === 1 ? '' : 's'} {root.phases.join(', ')}
                </li>
              ))}
            </ul>
          )}
          {view.accounts?.allGone && (
            <AccountsBanner unusable={view.accounts.unusable} total={view.accounts.total} />
          )}
          {view.evidence && <EvidenceLine evidence={view.evidence} />}
          {tree && (
            <p className="text-2xs text-ink-muted">
              Verified on the tree below — a red on another branch is not this phase’s.
              <TreeLine tree={tree} testId="halt-tree" className="text-ink-muted" />
            </p>
          )}
          {protectedPath && (
            <p data-testid="halt-protected" className="max-w-prose text-2xs text-ink-muted">
              The session was refused an edit to <span className="font-mono text-ink">{protectedPath}</span>:
              the CLI keeps that folder for a person. Make the edit by hand, then answer Done — continue.
            </p>
          )}
          {allRefused && (
            <p data-testid="halt-refused-watch" className="max-w-prose text-2xs text-ink-muted">
              None of the refs it declared can land — every one was refused, so nothing will resume it by
              itself.
            </p>
          )}
          {view.holders.length > 0 && <HolderList slug={run.slug} holders={view.holders} />}
          {view.kind === 'plan-approval' && view.phase != null && (
            <PlanReader slug={run.slug} phase={view.phase} />
          )}
          {children}
          <RecoveryActions
            target={recoveryTarget}
            ctx={{ ...view.ctx, run }}
            max={2}
            legend
            leadTestId="halt-recommended"
          />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((was) => !was)}
          className="flex items-center gap-1 self-start text-2xs text-ink-muted hover:text-ink [@media(hover:none)]:min-h-(--tap-min)"
          data-testid="halt-details-toggle"
        >
          <ChevronRight size={12} aria-hidden className={cn('transition-transform', open && 'rotate-90')} />
          {open ? 'Hide the details' : 'Details: the runner’s words, the ladder, the watch'}
        </button>
      </div>
      {open && <Details view={view} run={run} record={recordFor} errand={errand} />}
    </section>
  );
}
