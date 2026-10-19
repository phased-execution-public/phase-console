/**
 * The plans as cards — the browsing view (7.0, quiet-console phase 9).
 *
 * ```
 * ▌● Running (Active)                            2h ago
 * ▌storefront redesign
 * ▌████████████████▌█▐▒▒▒▒░░░░░░░░░░░
 * ▌41 done · 1 in progress · 1 next up · 4 waiting · 25 left · 56 %
 * ▌5 sessions  ~2–3 h of work left (estimate)
 * ▌P43 next up
 * ```
 *
 * One plan at a time, with room the list does not have: the plan's own
 * status badge beside the run's word (#361), the phases in proportion at
 * their own width with every count in words (#360), the estimate in full,
 * the phases next up as their own ways in, and what is wrong said in a
 * sentence. The same row, the same pieces
 * (`row.tsx`) — only the room differs. A card is a tone, never a shadow; its
 * leading edge wears the mark's hue, the edge a run row wears on Runs.
 */

import { progressReading } from '@shared/plan-vocab.js';
import { etaLabel, etaTitle } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Button, KeyValue, Mono, RelativeTime } from '@/ui';
import { planHref } from '@/shell/routes';
import { leftWords, markPaint, repoLabel, type PlanRow } from './model';
import { ConcernLines, NextUpLinks, PlanLine, PlanMark, RunLink } from './row';

export function PlanCard({
  row,
  onInspect,
  everything = false,
}: {
  row: PlanRow;
  onInspect?: (row: PlanRow) => void;
  /** Everything on: the facts the list draws as extra columns, on the card. */
  everything?: boolean;
}) {
  const paint = markPaint(row);
  return (
    <article
      data-plan-card={row.slug}
      aria-label={row.title}
      className={cn(
        'flex min-w-0 flex-col gap-2 rounded-lg border border-rule bg-surface px-(--tile-pad-x) py-(--tile-pad-y)',
        paint && `state-${paint} border-s-2 border-s-state`,
      )}
    >
      <div className="flex min-w-0 items-center justify-between gap-3">
        <PlanMark row={row} />
        {row.activity > 0 && (
          <RelativeTime at={row.activity} live={false} className="shrink-0 text-meta text-ink-faint" />
        )}
      </div>
      <h3 className="min-w-0 text-section text-ink">
        <a href={planHref(row.slug)} className="break-words rounded-sm hover:underline">
          {row.title}
        </a>
      </h3>
      <PlanLine row={row} />
      <p className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 text-meta text-ink-muted">
        <span className="tnum">{leftWords(row)}</span>
        {row.eta && !row.isClosed && (
          <span title={etaTitle(row.eta)}>{etaLabel(row.eta.lowMs, row.eta.highMs, row.eta.basis)}</span>
        )}
      </p>
      <NextUpLinks row={row} />
      <ConcernLines row={row} skipWaiting />
      {everything && (
        <KeyValue
          className="text-meta"
          items={[
            ['Slug', <Mono key="slug" value={row.slug} />],
            row.phases > 0 && (['Done', progressReading(row).text] as const),
            Boolean(row.run) && (['Run', <RunLink key="run" row={row} />] as const),
            row.repos.length > 0 && (['Repositories', repoLabel(row.repos).title] as const),
            Boolean(row.branch) && (['Branch', <Mono key="branch" value={row.branch!} />] as const),
            ['Handoffs', String(row.handoffCount)],
          ]}
        />
      )}
      {onInspect && (
        <Button size="sm" variant="ghost" className="-ms-2 self-start" onClick={() => onInspect(row)}>
          Inspect
        </Button>
      )}
    </article>
  );
}

/** A gallery of cards — one column on a phone, two from 900, three from 1200. */
export function PlanCards({
  rows,
  onInspect,
  label,
  everything = false,
}: {
  rows: readonly PlanRow[];
  onInspect?: (row: PlanRow) => void;
  label: string;
  everything?: boolean;
}) {
  return (
    <ul aria-label={label} className="grid min-w-0 grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
      {rows.map((row) => (
        <li key={row.slug} className="min-w-0">
          <PlanCard row={row} onInspect={onInspect} everything={everything} />
        </li>
      ))}
    </ul>
  );
}
