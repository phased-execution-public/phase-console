/**
 * The cells every phase table is built from — the plan's phases grid, the
 * Source view's plan table and the inspector's facts read a phase through
 * these, so a phase cannot read one way in one place and another in the next.
 *
 * Presentation over data already on the wire: nothing here fetches, and
 * nothing here decides what may run — `phaseActions` (`shared/phase-model.js`)
 * does, so a table, a dialog and the server give one answer.
 *
 * Memoised because a board is drawn once per phase and the events that redraw
 * it are almost always news about ONE phase; the memo pays only because the
 * query layer's structural sharing hands back the SAME object for every phase
 * a refetch did not change.
 */

import { memo, type ReactNode } from 'react';
import { scopeOfRow } from '@shared/scope.js';
import type { PhaseEta, PhaseLock, PhaseView } from '@/data/api';
import { cn } from '@/lib/cn';
import { countdown, plural, relativeTime, weight } from '@/lib/format';
import { lockTitle } from '@/lib/status-vocab';
import { KeyValue, RelativeTime } from '@/ui';
import { OpsStatus, type WordOf } from '@/ui/status';
import { plainText } from '@/ui/markdown';
import { handoffHref, phaseHref } from '@/shell/routes';

/** The Repos cell as scope tokens, never empty — a blank cell means `all`. */
export const scopeTokens = scopeOfRow as (cell: string | undefined) => string[];

/* ---------------- the claim ---------------- */

/**
 * Who holds a phase, and for how much longer — in the cell, not behind a
 * hover: a claim you cannot attribute is a claim you cannot act on, and a
 * phone has no hover. A lapsed lease reads "stale claim", never "held": one
 * blocks you and the other only warns.
 */
export const LockWords = memo(function LockWords({
  lock,
  compact = false,
  className,
}: {
  lock?: PhaseLock | undefined;
  compact?: boolean;
  className?: string;
}) {
  if (!lock) return null;
  const left = countdown(lock.leaseUntil);
  const title =
    (lockTitle(lock.expired ? 'stale' : 'live') ?? '') +
    `\n\n${lock.owner}${lock.host ? ` on ${lock.host}` : ''}` +
    (lock.claimedAt ? `\nclaimed ${relativeTime(lock.claimedAt)}` : '') +
    (lock.scope?.length ? `\nscope: ${lock.scope.join(', ')}` : '');
  return (
    <span
      className={cn('min-w-0 break-words text-meta text-ink', className)}
      title={title}
      data-lock={lock.expired ? 'stale' : 'live'}
    >
      {lock.expired ? 'stale claim' : 'held'}
      {!compact && (
        <>
          {' by '}
          <span className="font-mono">{lock.owner}</span>
        </>
      )}
      {/* `countdown` says "10m left" itself. */}
      {!lock.expired && left && left !== '—' ? `, ${left}` : ''}
    </span>
  );
});

/** The Lock column — the words, or the honest blank that means nobody holds it. */
export const LockCell = memo(function LockCell({
  lock,
  compact,
}: {
  lock?: PhaseLock | undefined;
  compact?: boolean;
}) {
  if (!lock) return <span className="text-meta text-ink-faint">—</span>;
  return <LockWords lock={lock} compact={compact ?? false} />;
});

/* ---------------- dependencies ---------------- */

/** A phase number as a link — every dependency edge is one of these. */
export function PhaseLink({
  slug,
  phase,
  suffix,
  title,
}: {
  slug: string;
  phase: number;
  suffix?: ReactNode;
  title?: string;
}) {
  return (
    <a
      href={phaseHref(slug, phase)}
      title={title}
      className="tap-line rounded-sm text-meta whitespace-nowrap text-ink tabular-nums underline-offset-2 hover:underline"
    >
      P{phase}
      {suffix}
    </a>
  );
}

/**
 * What a phase waits on, and how much waits on it — both directions, always:
 * "needs P2, P3" on a phase long done is how the plan's shape reads, and
 * `unblocks` decides which of two ready phases is worth starting first.
 */
export const DepsCell = memo(function DepsCell({
  slug,
  phase,
  linked = true,
  max = 6,
}: {
  slug: string;
  phase: PhaseView;
  linked?: boolean;
  /** How many are drawn before the rest become a count — a late phase can depend on twenty. */
  max?: number;
}) {
  const needs = phase.analysis?.dependsOn ?? phase.row?.dependsOn ?? [];
  const unblocks = phase.analysis?.unblocks ?? 0;
  const downstream = phase.analysis?.transitiveDependents?.length ?? 0;
  if (!needs.length && !unblocks) return <span className="text-meta text-ink-faint">—</span>;
  return (
    <div className="flex min-w-0 flex-col gap-0.5 text-meta">
      {needs.length > 0 && (
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
          <span className="text-ink-muted">needs</span>
          {linked ? (
            <>
              {needs.slice(0, max).map((dep) => (
                <PhaseLink key={dep} slug={slug} phase={dep} />
              ))}
              {needs.length > max && (
                <span
                  className="text-ink-muted tabular-nums"
                  title={`Also needs ${needs
                    .slice(max)
                    .map((d) => `P${d}`)
                    .join(', ')}`}
                >
                  {needs.length - max} more
                </span>
              )}
            </>
          ) : (
            <span className="text-ink tabular-nums">{needs.map((d) => `P${d}`).join(', ')}</span>
          )}
        </span>
      )}
      {unblocks > 0 && (
        <span
          className="text-ink-muted"
          title={downstream > unblocks ? `${plural(downstream, 'phase')} downstream in all` : undefined}
        >
          unblocks {unblocks}
          {downstream > unblocks ? `, ${downstream} downstream` : ''}
        </span>
      )}
    </div>
  );
});

/* ---------------- size and estimate ---------------- */

/** How big the phase is, what that weighs, and what it was expected to take. */
export const SizeCell = memo(function SizeCell({
  phase,
  eta,
}: {
  phase: PhaseView;
  eta?: PhaseEta | undefined;
}) {
  return (
    <span className="flex min-w-0 flex-col text-meta">
      <span className="text-ink" title={`weight ${weight(phase.weight)}`}>
        {phase.size || '—'}
      </span>
      {eta?.label && (
        <span className="text-ink-muted" title={`An estimate (${eta.basis}), not a measurement.`}>
          {eta.label}
        </span>
      )}
    </span>
  );
});

/* ---------------- scope ---------------- */

/** How many tokens are drawn before the rest become a count; the whole list is in the title. */
const SCOPE_SHOWN = 2;

/**
 * The repos a phase touches — what decides what may run beside it. A blank
 * Repos cell is `all`, the honest reading of "this might touch anything", and
 * the reason the phase runs alone. Paths an operator wrote: mono, and free to
 * break, because a two-segment submodule path does not fit a narrow column.
 */
export const ScopeWords = memo(function ScopeWords({
  tokens,
  conflicts,
}: {
  tokens: readonly string[];
  conflicts?: readonly string[] | undefined;
}) {
  const shown = tokens.slice(0, SCOPE_SHOWN);
  const hidden = tokens.length - shown.length;
  return (
    <span
      className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-meta"
      title={tokens.join(', ') + (conflicts?.length ? `\n\nwould collide with: ${conflicts.join(', ')}` : '')}
    >
      {shown.map((token) => (
        <span
          key={token}
          className={cn('min-w-0 wrap-anywhere font-mono', token === 'all' ? 'text-ink' : 'text-ink-muted')}
        >
          {token}
        </span>
      ))}
      {hidden > 0 && <span className="text-ink-muted tabular-nums">{hidden} more</span>}
      {conflicts?.length ? <span className="text-ink">collides with {conflicts.join(', ')}</span> : null}
    </span>
  );
});

/** The Repos cell, read through `scopeOfRow` — the one reading of a plan's Repos column. */
export const ScopeCell = memo(function ScopeCell({
  phase,
  conflicts,
}: {
  phase: PhaseView;
  conflicts?: readonly string[] | undefined;
}) {
  return <ScopeWords tokens={scopeTokens(phase.row?.repos)} conflicts={conflicts} />;
});

/* ---------------- the phase's prose and facts ---------------- */

const prose = (text?: string) =>
  text ? <span className="whitespace-pre-wrap">{plainText(text)}</span> : null;

/**
 * Everything about a phase that does not fit in a row: its prose (Goal, Read
 * first, Files, Steps, Exit criteria, Verification, Handoff must record), its
 * shape in the graph, its claim and its handoff. `KeyValue` drops an empty
 * row, so a phase with no gates simply has no Gates line.
 */
export function PhaseDetails({
  slug,
  phase,
  eta,
}: {
  slug: string;
  phase: PhaseView;
  eta?: PhaseEta | undefined;
}) {
  const a = phase.analysis;
  const lock = phase.lock;
  const h = phase.handoff;
  const links = (phases: readonly number[]) => (
    <span className="flex flex-wrap gap-x-2">
      {phases.map((d) => (
        <PhaseLink key={d} slug={slug} phase={d} />
      ))}
    </span>
  );
  return (
    <div className="flex flex-col gap-4" data-testid={`phase-details-${phase.phase}`}>
      <KeyValue
        items={[
          ['Goal', prose(phase.goal)],
          [
            'Gates',
            phase.gates ? (
              <span>
                {plainText(phase.gates)}
                {phase.gateCheck && <span className="text-ink-muted"> — {phase.gateCheck}</span>}
              </span>
            ) : null,
          ],
          ['Read first', prose(phase.readFirst)],
          ['Files', prose(phase.files)],
          ['Steps', prose(phase.steps)],
          ['Exit criteria', prose(phase.exitCriteria ?? phase.row?.exitCriteria)],
          ['Verification', prose(phase.verification)],
          ['Handoff must record', prose(phase.handoffMustRecord)],
        ]}
      />
      <KeyValue
        items={[
          ['Size', `${phase.size}, weight ${weight(phase.weight)}`],
          ['Estimate', eta?.label ? `${eta.label} (${eta.basis})` : null],
          ['Model', phase.model ? <span className="font-mono">{phase.model}</span> : null],
          ['Effort', phase.effort],
          ['Depends on', a?.dependsOn.length ? links(a.dependsOn) : null],
          ['Unblocks', a?.dependents.length ? links(a.dependents) : null],
          [
            'Downstream',
            a?.transitiveDependents.length ? plural(a.transitiveDependents.length, 'phase') : null,
          ],
          ['Critical path', a?.onCriticalPath ? 'on the longest remaining chain' : null],
          ['Parallel-safe with', phase.row?.parallelSafe],
          ['Repos', <span className="font-mono">{phase.row?.repos || 'all'}</span>],
        ]}
      />
      {lock && (
        <KeyValue
          items={[
            ['Claimed by', <span className="font-mono">{lock.owner}</span>],
            ['Host', lock.host ? <span className="font-mono">{lock.host}</span> : null],
            ['Claimed', lock.claimedAt ? <RelativeTime at={lock.claimedAt} /> : null],
            ['Lease', lock.expired ? 'lapsed — free to take over' : countdown(lock.leaseUntil) || null],
            [
              'Claim scope',
              lock.scope?.length ? lock.scope.join(', ') : 'unstated — collides with everything',
            ],
          ]}
        />
      )}
      {h && (
        <KeyValue
          items={[
            [
              'Handoff',
              <a
                href={handoffHref(slug, phase.phase)}
                className="text-ink underline-offset-2 hover:underline"
              >
                {h.title || h.file}
              </a>,
            ],
            ['Handoff status', <OpsStatus vocab="handoff" word={h.status as WordOf<'handoff'>} />],
            ['Completed', h.completed],
            ['Outstanding', prose(h.outstanding)],
            [
              'Skills used',
              h.skillsUsed.length ? <span className="font-mono">{h.skillsUsed.join(', ')}</span> : null,
            ],
            ['Prompts', h.prompts || null],
          ]}
        />
      )}
      {phase.qa && (
        <KeyValue items={[['QA', `${phase.qa.result}${phase.qa.report ? ` — ${phase.qa.report}` : ''}`]]} />
      )}
    </div>
  );
}
