/**
 * The pieces a plan row is made of — read by BOTH layouts.
 *
 * `card.tsx` is the browsing layout and `list.tsx` is the comparing one; this
 * file is what they cannot be allowed to disagree about. A chip whose rule
 * lived in one of them would mean a plan reading `halted` as a card and blank
 * as a table row, which is the defect this split exists to prevent.
 *
 * ## The signature
 *
 * Every plan carries a **full-width track** — its phases as one bar, painted
 * done / in progress / stuck / ready and then the length still to be laid. Sixty
 * -five of them stacked is sixty-five parallel lines of different fill, and the
 * shape of the estate is legible before a single word is read: which plans are
 * nearly home, which are one amber notch away from moving, which are a long grey
 * run nobody has started.
 *
 * It costs nothing. `ui/progress.tsx` takes exactly the four counts
 * `/api/plans` already sends, so the whole picture is drawn from the list
 * payload — no per-plan detail fetch, no fan-out, honest at any length. The
 * dashboard's `RouteStrip` draws a segment per phase and is the better picture,
 * but it needs the plan detail; six of those is a reasonable trade for a teaser
 * and sixty-five is not.
 *
 * ## Two layouts, one vocabulary
 *
 * The card is for browsing — one plan at a time, with room for its ready phases
 * as their own tap targets. The table is for comparing — every plan on one
 * screen, sortable by the column you are asking about. Both read the same
 * `PlanRow`, so they cannot disagree; what differs is only how much room each
 * fact gets.
 */

import { AlertTriangle, Hand, Lock } from 'lucide-react';
import { PlanStatusBadge, ViewBadge, type WordOf } from '@/components/ui/status';
import { Badge, Progress } from '@/components/ui';
import { closedTitle } from '@/lib/closure';
import { cn } from '@/lib/cn';
import { planHref } from '@shared/routes.js';
import { progressReading } from '@shared/plan-vocab.js';
import { runsBayHref } from '@/app/routes';
import { runStatusTitle } from '@/lib/status-vocab';
import { concerns, type PlanRow } from './model';

/* ------------------------------------------------------------------ *
 * Shared pieces
 * ------------------------------------------------------------------ */

/**
 * What the autopilot is doing to this plan, when it has ever done anything —
 * the run's view in context (`describeRun`: a closed plan settles it, an open
 * summons for it is amber), with the phase it is on beside it.
 */
export function RunChip({ row, className }: { row: PlanRow; className?: string }) {
  if (!row.run) return null;
  const { view, word, activePhase } = row.run;
  return (
    // `tap-area` and not a taller badge: the chip's own height is what makes a
    // card's badge row read as one line of state, and the target is the thing
    // that has to reach the floor, not the paint. It is the only route from a
    // plan card to the run it names.
    <a
      href={planHref(row.slug, 'run')}
      className={cn('tap-area inline-flex shrink-0 items-center gap-1 rounded-sm', className)}
    >
      <ViewBadge view={view} pulse={word === 'running'} title={runStatusTitle(word)} />
      {activePhase != null && (
        <>
          {' '}
          <span className="font-mono text-2xs tabular-nums text-ink-muted">P{activePhase}</span>
        </>
      )}
    </a>
  );
}

/** The track. Rendered only for something that has phases — a document has none. */
export function Track({ row, className }: { row: PlanRow; className?: string }) {
  if (!row.phases) {
    return <span className={cn('text-2xs text-ink-faint', className)}>no phases</span>;
  }
  // On a closed plan only `done` is painted. The engine still reports which
  // phases *would* be ready, in progress or stuck, but those are readings of
  // live work: an amber "ready" notch on an abandoned plan is the track saying
  // "this one could move today", which is the single thing closure denies. What
  // is left reads as unlaid grey — which is exactly what it is.
  // A board the engine could not read is unknown (#96), never a bar at 0 %.
  const reading = progressReading(row);
  if (!reading.known) {
    return (
      <span className={cn('font-mono text-2xs text-warn', className)} title={reading.title}>
        {reading.text}
      </span>
    );
  }
  const live = !row.isClosed;
  return (
    <Progress
      className={className}
      total={row.phases}
      done={row.done}
      inProgress={live ? row.inProgress.length : 0}
      ready={live ? row.readyPhases.length : 0}
      stuck={live ? row.stuck.length : 0}
    />
  );
}

/**
 * Repos, at the length a row can carry.
 *
 * One plan in this source names fourteen — a hundred and seventy-eight
 * characters, which as one truncated line reads `all · aws · customer-app · doc…`
 * and tells you nothing the first name did not. Two and a count is the same fact
 * at a size that fits; the full list is the `title`.
 */
export function repoLabel(repos: string[]): { text: string; title: string } {
  const title = repos.join(' · ');
  if (repos.length <= 3) return { text: title, title };
  return { text: `${repos.slice(0, 2).join(' · ')} +${repos.length - 2}`, title };
}

/**
 * The plan's own status word, and — when it is terminal — the fact that this
 * makes the plan closed.
 *
 * One chip, not two. The status word IS the more useful label (`abandoned`
 * says something `CLOSED` does not), so closure is carried by the padlock and
 * the tooltip rather than by a second chip repeating the first in capitals.
 * Non-terminal words (`proposal`, `backlog`) keep the plain rendering.
 */
export function ClosedChip({ row }: { row: PlanRow }) {
  // PAINTED, since control-tower phase 23: the plan vocabulary's own badge, so
  // a status line nobody knows draws as Unknown instead of as a grey word.
  if (!row.isClosed) {
    return (
      <span title={"The plan's own frontmatter status — set by hand when a plan is finished or shelved."}>
        <PlanStatusBadge status={row.status as WordOf<'plan'>} />
      </span>
    );
  }
  return (
    // `PlanRow` already carries `status`, `closedOn` and `closedReason`, which
    // is all `closedTitle` reads — no adapter needed.
    <span title={closedTitle(row)} className="inline-flex items-center gap-1 text-ink-faint">
      <Lock size={11} className="shrink-0" aria-hidden />
      <PlanStatusBadge status={row.status as WordOf<'plan'>} />
    </span>
  );
}

/**
 * The one thing most wrong with this plan that is not already on the row.
 *
 * `needs-you` is skipped deliberately. It is in `concerns()` because that list
 * is also the `attention` sort key, and somebody waiting is the strongest
 * reason to sort a plan to the top — but `NeedsYouChip` is already saying it in
 * its own colour beside the title, and a card that reads `2 waiting` and
 * `2 things waiting on you` has spent two chips on one fact. This shows the
 * worst thing the reader has NOT been told yet.
 */
export function ConcernChip({ row }: { row: PlanRow }) {
  const [worst] = concerns(row).filter((concern) => concern.key !== 'needs-you');
  if (!worst) return null;
  // A caution asks nothing of a person, so it is never amber: red for what is
  // broken, the quiet neutral for what is merely worth knowing (6.0).
  return (
    <Badge tone={worst.tone === 'bad' ? 'bad' : 'neutral'} className="min-w-0 max-w-full">
      {worst.tone === 'bad' ? (
        <AlertTriangle size={11} className="shrink-0" aria-hidden />
      ) : (
        <Lock size={11} className="shrink-0" aria-hidden />
      )}
      <span className="truncate">{worst.text}</span>
    </Badge>
  );
}

/**
 * How many things are waiting on a person, when any are.
 *
 * The loudest thing a row can carry, and the only one that is somebody being
 * asked rather than a condition worth noticing — so it is a link, straight to
 * the inbox band of Now filtered to nothing: the operator arrives at the list
 * of what is waiting, which is where the actions are.
 *
 * Nothing at zero. A permanent grey "0 waiting" on sixty-five rows is how a
 * count stops being read.
 */
export function NeedsYouChip({ row }: { row: PlanRow }) {
  if (!row.needsYou) return null;
  // A summons — open inbox items waiting on a person — and so the one amber on
  // the row (`accent` IS the needs-you paint).
  return (
    <a href={runsBayHref('needs-you')} className="tap-area shrink-0 rounded-sm">
      <Badge tone="accent" mono className="[@media(hover:none)]:min-h-(--tap-min)">
        <Hand size={11} strokeWidth={2.25} className="shrink-0" aria-hidden />
        {row.needsYou} waiting
      </Badge>
    </a>
  );
}

/** Why a plan has nothing ready — five different facts, not one empty state. */
export function restingReason(row: PlanRow): string {
  // Closure comes FIRST, and says how much never got done. An abandoned plan
  // with four phases left is not "every phase is done" and it is not "waiting on
  // another" — it is stopped, and the number is the only part of that a row can
  // usefully carry. `isComplete` cannot answer this: it is true of a finished
  // plan and false of an abandoned one, and both are closed.
  if (row.isClosed) {
    const left = Math.max(0, row.phases - row.done);
    if (!left) return `${row.status} — every phase is done`;
    return `${row.status} — ${left} of ${row.phases} phases never ran`;
  }
  if (row.isComplete) return 'every phase is done';
  if (row.inProgress.length) return `phase ${row.inProgress.join(', ')} in progress`;
  if (row.stuck.length) return `phase ${row.stuck.join(', ')} is stuck`;
  if (!row.phases) return 'a document, not a phased plan';
  return 'nothing ready — every remaining phase waits on another';
}
