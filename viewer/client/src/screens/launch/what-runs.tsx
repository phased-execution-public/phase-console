/**
 * What runs.
 *
 * The plan, the phases ready now, the sessions a person could batch them into by hand,
 * the scopes they touch, the gates that will hold and the claims this run
 * would queue behind — the departure notice's fold, under the departure line;
 * the two controls that narrow or chain it are the Scope category's.
 *
 * The glance is the ready set and one line of counts; one fold more is every
 * open phase behind "The N phases behind them" and every batch behind
 * "All N sessions".
 */

import type { PhaseView } from '@/data/api';
import { cn } from '@/lib/cn';
import { countdown, plural } from '@/lib/format';
import { Mono, SectionHeading } from '@/ui';
import { Disclosure } from '@/ui/disclosure';
import { PhaseStatus, type WordOf } from '@/ui/status';
import { phaseHref } from '@shared/routes.js';
import { gateWho, liveClaim, useLaunchFacts } from './model/facts';
import { useSetupForm } from './form-context';
import { ScopeChip } from './sections';

/** How many rows the glance shows before folding the rest. */
const GLANCE = 6;

export function WhatRuns() {
  const f = useSetupForm();
  const facts = useLaunchFacts();
  const { detail, phases, willRun, scoped, gated, claimed, batches } = facts;
  const summary = detail?.summary;
  const run = f.context.run ?? null;
  const open = phases.filter((p) => p.state !== 'done');
  const rest = open.filter((p) => !willRun.some((w) => w.phase === p.phase));

  return (
    <div className="flex min-w-0 flex-col gap-5">
      {/* The plan. */}
      <section className="flex min-w-0 flex-col gap-1">
        <SectionHeading as="h4">Plan</SectionHeading>
        <p className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <span className="min-w-0 break-words text-body font-medium text-ink">
            {summary?.title ?? facts.slug ?? 'this plan'}
          </span>
          {facts.slug && <Mono value={facts.slug} className="min-w-0 wrap-anywhere" />}
        </p>
        {summary && (
          <p className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 text-meta text-ink-muted">
            <span>
              {plural(summary.phases, 'phase')}, {summary.done} done, {plural(summary.ready.length, 'phase')}{' '}
              ready now
            </span>
            {summary.repos.length ? (
              <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span>touches</span>
                {summary.repos.map((repo) => (
                  <ScopeChip key={repo}>{repo}</ScopeChip>
                ))}
              </span>
            ) : null}
          </p>
        )}
        {facts.resumeRunId && run && (
          <p className="max-w-(--measure) text-meta text-ink-muted">
            Picks up run <Mono value={facts.resumeRunId} className="wrap-anywhere" />
            {run.status ? ` (${run.status})` : ''} rather than starting a fresh record.
          </p>
        )}
      </section>

      {/* The phases that board first. */}
      <section className="flex min-w-0 flex-col gap-2">
        <SectionHeading as="h4">
          {f.mode === 'phase'
            ? 'This phase'
            : scoped
              ? 'In scope'
              : f.mode === 'live'
                ? 'Still to run'
                : 'Ready now'}
        </SectionHeading>
        {willRun.length === 0 ? (
          <p className="max-w-(--measure) text-body text-ink-muted">
            {scoped
              ? 'Nothing in that scope is open — every phase named there is done, or is not on the board.'
              : 'Nothing is ready. Every open phase waits on another, so the run would halt at boarding with nothing to do.'}
          </p>
        ) : (
          <PhaseList phases={willRun.slice(0, GLANCE)} slug={facts.slug} />
        )}
        {/* The label carries the number, so the fold draws no count of its own. */}
        {willRun.length > GLANCE && (
          <Disclosure label={`All ${willRun.length} phases`} openLabel={`All ${willRun.length} phases`}>
            <PhaseList phases={willRun.slice(GLANCE)} slug={facts.slug} className="mt-2" />
          </Disclosure>
        )}
        {!scoped && f.mode !== 'phase' && rest.length > 0 && (
          <Disclosure
            label={`The ${plural(rest.length, 'phase')} behind them`}
            openLabel={`The ${plural(rest.length, 'phase')} behind them`}
          >
            <p className="mt-1 max-w-(--measure) text-meta text-ink-muted">
              Each boards as soon as everything it depends on is done, until the plan ends or a stop condition
              hits.
            </p>
            <PhaseList phases={rest} slug={facts.slug} className="mt-2" faint />
          </Disclosure>
        )}
      </section>

      {/* How the engine would batch them. */}
      {batches.length > 0 && f.mode !== 'phase' && (
        <section className="flex min-w-0 flex-col gap-2">
          <SectionHeading as="h4">Sessions</SectionHeading>
          <p className="max-w-(--measure) text-meta text-ink-muted">
            How a person could batch what is left by hand
            {facts.budget ? `, at ${facts.budget} a session` : ''}. The autopilot runs 1 phase ≥ 1 session and
            never batches.
          </p>
          <BatchList batches={batches.slice(0, 4)} />
          {batches.length > 4 && (
            <Disclosure
              label={`All ${plural(batches.length, 'session')}`}
              openLabel={`All ${plural(batches.length, 'session')}`}
            >
              <BatchList batches={batches.slice(4)} className="mt-2" />
            </Disclosure>
          )}
        </section>
      )}

      {/* What will hold, and what this queues behind. */}
      {(gated.length > 0 || claimed.length > 0) && (
        <section className="flex min-w-0 flex-col gap-2">
          <SectionHeading as="h4">Will hold</SectionHeading>
          <ul className="flex min-w-0 flex-col gap-1 text-body">
            {gated.map((p) => (
              <li
                key={`gate-${p.phase}`}
                className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 text-ink-muted"
              >
                <span className="shrink-0 text-meta tabular-nums">P{p.phase}</span>
                <span className="text-meta">gate</span>
                <span className="min-w-0 break-words">{gateWho(p)}</span>
                {p.gateCheck ? <span className="min-w-0 break-words text-meta">({p.gateCheck})</span> : null}
              </li>
            ))}
            {claimed.map((p) => {
              const claim = liveClaim(p)!;
              return (
                <li
                  key={`claim-${p.phase}`}
                  className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 text-ink-muted"
                >
                  <span className="shrink-0 text-meta tabular-nums">P{p.phase}</span>
                  <span className="min-w-0 break-words">
                    claimed by <Mono value={claim.owner} className="wrap-anywhere" />
                    {claim.leaseUntil ? `, ${countdown(claim.leaseUntil)}` : ''} — this run queues behind it
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}

function PhaseList({
  phases,
  slug,
  className,
  faint = false,
}: {
  phases: PhaseView[];
  slug: string | undefined;
  className?: string;
  faint?: boolean;
}) {
  return (
    <ul className={cn('flex min-w-0 flex-col gap-1', className)}>
      {phases.map((p) => {
        const repos = (p.row?.repos ?? '')
          .split(/[,\s]+/)
          .map((r) => r.trim())
          .filter(Boolean);
        const claim = liveClaim(p);
        const who = gateWho(p);
        return (
          <li
            key={p.phase}
            className={cn(
              'flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 py-0.5 text-body',
              faint && 'text-ink-muted',
            )}
          >
            {slug ? (
              <a
                href={phaseHref(slug, p.phase)}
                className="tap-cell shrink-0 text-meta text-ink-muted tabular-nums hover:text-ink"
              >
                P{p.phase}
              </a>
            ) : (
              <span className="shrink-0 text-meta text-ink-muted tabular-nums">P{p.phase}</span>
            )}
            <span className="min-w-24 flex-1 break-words">{p.title}</span>
            <span className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5">
              {/* The board word as the status model draws it; the dot breathes
                  only over an observed live fact, never over the word. A gate
                  and a claim are waits, not summons — the inbox is where a
                  person is asked — so they are plain words. */}
              <PhaseStatus board={p.state as WordOf<'board'>} live={Boolean(p.live)} />
              {who && (
                <span className="text-meta text-ink-muted" title={p.gates ?? undefined}>
                  gated: {who}
                </span>
              )}
              {claim && <span className="text-meta text-ink-muted">claimed</span>}
              {repos.map((repo) => (
                <ScopeChip key={repo}>{repo}</ScopeChip>
              ))}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function BatchList({ batches, className }: { batches: LaunchBatch[]; className?: string }) {
  return (
    <ul className={cn('flex min-w-0 flex-col gap-1 text-body', className)}>
      {batches.map((group) => (
        <li key={group.index} className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <span className="shrink-0 text-ink-muted">Session {group.index}</span>
          <span className="text-meta text-ink tabular-nums">P{group.phases.join(', P')}</span>
          <span className="text-meta text-ink-muted tabular-nums">{group.weight}</span>
          {group.gated && <span className="text-meta text-ink-muted">gated</span>}
          {group.note && <span className="min-w-0 break-words text-meta text-ink-muted">{group.note}</span>}
        </li>
      ))}
    </ul>
  );
}

type LaunchBatch = ReturnType<typeof useLaunchFacts>['batches'][number];
