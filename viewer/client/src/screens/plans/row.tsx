/**
 * What a plan is drawn with — read by BOTH views, the list and the cards, so
 * a plan cannot read one way as a line and another as a card.
 *
 * The row's five facts are the mark (a dot and its precise word), the name,
 * the plan as a line folded to labelled stations, the work left and when it
 * last moved. The line is the console's one graphic (design.md §7): sixty
 * plans stacked are sixty parallel lines of different fill, and the shape of
 * the estate reads before a word does. It is drawn from the four counts the
 * list already carries — no per-plan fetch — and a board the engine could not
 * read draws the shared reading (#96), never a line at 0 %.
 */

import { progressReading } from '@shared/plan-vocab.js';
import { cn } from '@/lib/cn';
import { AttentionMark, DotWord, PlanStatus, type WordOf } from '@/ui/status';
import { Station } from '@/ui/track/station';
import { Track } from '@/ui/track/track';
import { phaseHref, runHref } from '@/shell/routes';
import { closedTitle } from '@/lib/closure';
import { concerns, kindWord, lineOf, markKind, type PlanRow } from './model';

/** The row's dot and word — see `markKind` for which word leads. */
export function PlanMark({ row, size = 'sm' }: { row: PlanRow; size?: 'sm' | 'md' }) {
  switch (markKind(row)) {
    case 'kind':
      return <span className="whitespace-nowrap text-meta text-ink-muted">{kindWord(row)}</span>;
    case 'attention':
      return (
        <AttentionMark
          level="needs-you"
          size={size}
          title={`${row.needsYou} waiting on you — on Your turn`}
          data-testid="plan-mark"
        />
      );
    // Never breathing: the run is observed live on Runs, and a library of
    // pulsing dots would spend the page's one motion on every running plan.
    case 'run':
      return <DotWord view={row.run!.view} size={size} withNote={false} data-testid="plan-mark" />;
    case 'plan':
      return (
        <PlanStatus
          status={row.status as WordOf<'plan'>}
          size={size}
          withNote={false}
          data-testid="plan-mark"
          {...(row.isClosed ? { title: closedTitle(row) } : {})}
        />
      );
  }
}

/**
 * The plan as a line, at the size of a row. Labelled stations, never colour
 * alone; a plan with no phases draws nothing, and an unread board says so.
 */
export function PlanLine({ row, className }: { row: PlanRow; className?: string }) {
  if (!row.phases) return <span className={cn('text-meta text-ink-faint', className)}>No phases</span>;
  const reading = progressReading(row);
  if (!reading.known) {
    return (
      <span
        data-testid="plan-line-unknown"
        className={cn('text-meta text-ink-muted', className)}
        title={reading.title}
      >
        {reading.text}
      </span>
    );
  }
  const stations = lineOf(row);
  // A floor of its own: on a phone's card the line rides the quiet line beside
  // the mark and the clock, which would shrink it to its labels — stations
  // touching, no line between them. At 15rem it takes a line of its own there,
  // and in the list its column (min 280) always holds it.
  return (
    <Track
      label={`${row.title}: ${row.done} of ${row.phases} phases done`}
      className={cn('min-w-60', className)}
    >
      {stations.map((station) => (
        <Station
          key={station.key}
          paint={station.paint}
          settled={station.settled}
          data-phase={station.phase}
          data-count={station.count}
        >
          {station.label}
        </Station>
      ))}
    </Track>
  );
}

/**
 * The phases that could start now, each a way into itself — never on a closed
 * plan, whose ready phases stay populated by design and are a door nobody
 * will walk through.
 */
export function NextUpLinks({ row, max = 4 }: { row: PlanRow; max?: number }) {
  if (row.isClosed || !row.readyPhases.length) return null;
  const shown = row.readyPhases.slice(0, max);
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-meta">
      {shown.map((phase) => (
        <a
          key={phase}
          href={phaseHref(row.slug, phase)}
          className="tap-line whitespace-nowrap rounded-sm text-ink underline-offset-2 hover:underline"
        >
          P{phase} next up
        </a>
      ))}
      {row.readyPhases.length > max && (
        <span className="text-ink-muted">{row.readyPhases.length - max} more</span>
      )}
    </span>
  );
}

/** What is wrong with the plan, worst first — red for what is broken, quiet for what is worth knowing. */
export function ConcernLines({ row, skipWaiting = false }: { row: PlanRow; skipWaiting?: boolean }) {
  const list = concerns(row).filter((c) => !skipWaiting || c.key !== 'needs-you');
  if (!list.length) return null;
  return (
    <ul className="flex min-w-0 flex-col gap-0.5 text-meta">
      {list.map((concern) => (
        <li
          key={concern.key}
          data-concern={concern.key}
          className={cn(
            'min-w-0 break-words',
            concern.tone === 'bad' ? 'state-failed text-state' : 'text-ink-muted',
          )}
        >
          {concern.text}
        </li>
      ))}
    </ul>
  );
}

/** The newest run, as a way into its view — its word in context and the phase it is on. */
export function RunLink({ row }: { row: PlanRow }) {
  if (!row.run) return null;
  const { view, activePhase } = row.run;
  return (
    <a
      href={runHref(row.slug)}
      className="inline-flex min-w-0 items-center gap-1.5 rounded-sm hover:underline"
      title="Open the run"
    >
      <DotWord view={view} withNote={false} />
      {activePhase != null && <span className="tnum text-meta text-ink-muted">P{activePhase}</span>}
    </a>
  );
}
