/**
 * Stage 1 — What runs.
 *
 * The plan, the phases ready now, the sessions the engine batches them into,
 * the scopes they touch, the gates that will hold and the claims this run
 * would queue behind — and then the two controls that narrow or chain it.
 * Facts first, controls after: the operator reads what the board says before
 * deciding whether to change it.
 *
 * L0 is the ready set and one line of counts; L1 is every open phase behind
 * "All N open phases" and every batch behind "All N sessions".
 */

import { Chip, Disclosure, SectionHeading, StateChip } from '@/components/ui';
import type { PhaseView } from '@/lib/api';
import { cn } from '@/lib/cn';
import { countdown, plural } from '@/lib/format';
import { phaseHref } from '@shared/routes.js';
import { gateWho, liveClaim, useLaunchFacts } from './facts';
import { useSetupForm } from './form-context';
import { ScopeChip, ScopeSection } from './sections';

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
    <div className="flex flex-col gap-5">
      {/* The plan. */}
      <section className="flex flex-col gap-1">
        <SectionHeading as="h3" tone="muted">
          Plan
        </SectionHeading>
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="min-w-0 break-words font-display text-lg text-ink">
            {summary?.title ?? facts.slug ?? 'this plan'}
          </span>
          {facts.slug && (
            <span className="min-w-0 break-all font-mono text-2xs text-ink-muted">{facts.slug}</span>
          )}
        </div>
        {summary && (
          <p className="text-xs text-ink-muted">
            {plural(summary.phases, 'phase')} · {summary.done} done · {plural(summary.ready.length, 'phase')}{' '}
            ready now
            {summary.repos.length ? (
              <>
                {' '}
                · touches{' '}
                {summary.repos.map((repo) => (
                  <span key={repo} className="mr-1 inline-block align-baseline">
                    <ScopeChip>{repo}</ScopeChip>
                  </span>
                ))}
              </>
            ) : null}
          </p>
        )}
        {facts.resumeRunId && run && (
          <p className="text-xs text-ink-muted">
            Picks up run <span className="font-mono">{facts.resumeRunId}</span>
            {run.status ? ` (${run.status})` : ''} rather than starting a fresh record.
          </p>
        )}
      </section>

      {/* The phases that board first. */}
      <section className="flex flex-col gap-2">
        <SectionHeading as="h3" tone="muted">
          {f.mode === 'phase'
            ? 'This phase'
            : scoped
              ? 'In scope'
              : f.mode === 'live'
                ? 'Still to run'
                : 'Ready now'}
        </SectionHeading>
        {willRun.length === 0 ? (
          <p className="text-sm text-ink-muted">
            {scoped
              ? 'Nothing in that scope is open — every phase named there is done, or is not on the board.'
              : 'Nothing is ready. Every open phase waits on another, so the run would halt at boarding with nothing to do.'}
          </p>
        ) : (
          <PhaseList phases={willRun.slice(0, GLANCE)} slug={facts.slug} />
        )}
        {/* The label carries the number, so the fold draws no count of its own. */}
        {willRun.length > GLANCE && (
          <Disclosure label={`All ${willRun.length} phases`}>
            <PhaseList phases={willRun.slice(GLANCE)} slug={facts.slug} className="mt-2" />
          </Disclosure>
        )}
        {!scoped && f.mode !== 'phase' && rest.length > 0 && (
          <Disclosure label={`The ${plural(rest.length, 'phase')} behind them`}>
            <p className="mt-1 text-2xs text-ink-muted">
              Each boards as soon as everything it depends on is done, until the plan ends or a stop condition
              hits.
            </p>
            <PhaseList phases={rest} slug={facts.slug} className="mt-2" faint />
          </Disclosure>
        )}
      </section>

      {/* How the engine would batch them. */}
      {batches.length > 0 && f.mode !== 'phase' && (
        <section className="flex flex-col gap-2">
          <SectionHeading as="h3" tone="muted">
            Sessions
          </SectionHeading>
          <p className="text-2xs text-ink-muted">
            How the engine batches what is left{facts.budget ? ` at ${facts.budget} a session` : ''} — a
            suggestion the runner follows one phase at a time.
          </p>
          <BatchList batches={batches.slice(0, 4)} />
          {batches.length > 4 && (
            <Disclosure label={`All ${plural(batches.length, 'session')}`}>
              <BatchList batches={batches.slice(4)} className="mt-2" />
            </Disclosure>
          )}
        </section>
      )}

      {/* What will hold, and what this queues behind. */}
      {(gated.length > 0 || claimed.length > 0) && (
        <section className="flex flex-col gap-2">
          <SectionHeading as="h3" tone="muted">
            Will hold
          </SectionHeading>
          <ul className="flex flex-col gap-1 text-sm">
            {gated.map((p) => (
              <li key={`gate-${p.phase}`} className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                <span className="font-mono text-2xs text-ink-muted">P{p.phase}</span>
                <span className="min-w-0 break-words text-ink-muted">
                  gate — {gateWho(p)}
                  {p.gateCheck ? <span className="text-ink-muted"> ({p.gateCheck})</span> : null}
                </span>
              </li>
            ))}
            {claimed.map((p) => {
              const claim = liveClaim(p)!;
              return (
                <li key={`claim-${p.phase}`} className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                  <span className="font-mono text-2xs text-ink-muted">P{p.phase}</span>
                  <span className="min-w-0 break-words text-ink-muted">
                    claimed by <span className="font-mono">{claim.owner}</span>
                    {claim.leaseUntil ? `, ${countdown(claim.leaseUntil)}` : ''} — this run queues behind it
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {/* The controls that change the above. */}
      {(f.on('onlyPhases') || f.on('startAfter')) && (
        <section className="flex flex-col gap-2 border-t border-rule pt-4">
          <SectionHeading as="h3" tone="muted">
            Narrow or chain it
          </SectionHeading>
          <ScopeSection />
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
    <ul className={cn('flex flex-col divide-y divide-rule', className)}>
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
              'flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 py-1.5 text-sm',
              faint && 'text-ink-muted',
            )}
          >
            {slug ? (
              <a
                href={phaseHref(slug, p.phase)}
                className="tap-cell shrink-0 font-mono text-2xs text-ink-muted hover:text-ink"
              >
                P{p.phase}
              </a>
            ) : (
              <span className="shrink-0 font-mono text-2xs text-ink-muted">P{p.phase}</span>
            )}
            <span className="min-w-24 flex-1 break-words">{p.title}</span>
            <span className="flex min-w-0 flex-wrap items-center gap-1">
              <StateChip state={p.state} pulse={Boolean(p.live)} />
              {who && (
                <Chip tone="gate" title={p.gates ?? undefined}>
                  gate · {who}
                </Chip>
              )}
              {claim && <Chip tone="warn">claimed</Chip>}
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
    <ul className={cn('flex flex-col gap-1 text-sm', className)}>
      {batches.map((group) => (
        <li key={group.index} className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="shrink-0 text-ink-muted">Session {group.index}</span>
          <span className="font-mono text-2xs text-ink">P{group.phases.join(', P')}</span>
          <span className="font-mono text-2xs tabular-nums text-ink-muted">{group.weight}</span>
          {group.gated && <Chip tone="gate">gated</Chip>}
          {group.note && <span className="min-w-0 break-words text-2xs text-ink-muted">{group.note}</span>}
        </li>
      ))}
    </ul>
  );
}

type LaunchBatch = ReturnType<typeof useLaunchFacts>['batches'][number];
