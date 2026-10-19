/**
 * The station's hover card (one-pool phase 16, #376) — what a desk's pointer
 * or keyboard asks of a station, in place of the native `<title>` tooltip,
 * which could say only lines and offered nothing to press.
 *
 * ```
 * Phase 16: Phase graphs: tools, timeline…
 * In progress · size L · est. 2h 10m · $4.20 so far
 * 2 attempts · autopilot session 336e45cb · model opus
 * Claimed by autopilot/410a…, lease 1h 40m left
 * Gated: a person clears it · Handoff in progress
 * waits on 1 · unblocks 2
 * [Open phase] [Inspect] [Trace]
 * ```
 *
 * The facts come from the page (`HoverFacts`, built in `map-view.tsx` from the
 * plan's phases, its estimate, its cost and the run's records), so the map
 * itself stays a drawing of the route. A phone keeps its fact strip: a finger
 * has no hover, and its first tap is the question there.
 */

import { Button } from '@/ui';
import { cn } from '@/lib/cn';

/** Every line the card can carry about one phase; each is a sentence-case fact, absent when unknown. */
export interface HoverFacts {
  phase: number;
  title: string;
  /** The state's own word ("In progress"). */
  state: string;
  size: string;
  /** The phase's estimate, in words. */
  estimate?: string;
  /** What it has cost so far, in words. */
  cost?: string;
  attempts?: number;
  /** Who is driving it: the session and the model. */
  driver?: string;
  /** The claim and its lease, in words. */
  lock?: string;
  gate?: string;
  handoff?: string;
  /** What it waits on and what it unblocks — `traceWords`. */
  trace?: string;
}

/** The card's lines, in reading order — exported so a test can read them without a pointer. */
export function hoverLines(facts: HoverFacts): string[] {
  const first = [facts.state, `size ${facts.size}`, facts.estimate && `est. ${facts.estimate}`, facts.cost]
    .filter(Boolean)
    .join(' · ');
  const second = [
    facts.attempts ? `${facts.attempts} attempt${facts.attempts === 1 ? '' : 's'}` : '',
    facts.driver ?? '',
  ]
    .filter(Boolean)
    .join(' · ');
  const third = [facts.gate ?? '', facts.handoff ?? ''].filter(Boolean).join(' · ');
  return [first, second, facts.lock ?? '', third, facts.trace ?? ''].filter(Boolean);
}

export function HoverCard({
  facts,
  x,
  y,
  flip,
  href,
  onInspect,
  onTrace,
  onEnter,
  onLeave,
  className,
}: {
  facts: HoverFacts;
  /** Where the station stands in the frame, in CSS pixels from its top corner on the drawing's own axis. */
  x: number;
  y: number;
  /** Draw it before the station — it would run off the frame's far edge. */
  flip?: boolean;
  href?: string;
  onInspect?: () => void;
  onTrace?: () => void;
  onEnter?: () => void;
  onLeave?: () => void;
  className?: string;
}) {
  /* The drawing's x axis is physical — an SVG does not mirror with `dir` — so
     the card is placed on it by a transform inside an overlay that is LTR by
     construction, and its words take the page's direction again inside. */
  const shift = flip ? `calc(${x - 24}px - 100%)` : `${x + 24}px`;
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" dir="ltr">
      <div
        role="dialog"
        aria-label={`Phase ${facts.phase} facts`}
        data-testid="map-hover-card"
        data-phase={facts.phase}
        dir="auto"
        className={cn(
          'pointer-events-auto absolute top-0 z-(--z-base) flex w-72 max-w-[calc(100%-1rem)] flex-col gap-1 rounded-lg border border-rule-strong bg-surface p-3 shadow-overlay',
          className,
        )}
        style={{ insetInlineStart: 0, transform: `translate(${shift}, ${Math.max(8, y - 24)}px)` }}
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
      >
        <div className="text-body font-medium break-words text-ink">
          Phase {facts.phase}: {facts.title}
        </div>
        <ul className="flex flex-col gap-0.5 text-meta text-ink-muted tnum">
          {hoverLines(facts).map((line) => (
            <li key={line} className="break-words">
              {line}
            </li>
          ))}
        </ul>
        <div className="mt-1 flex flex-wrap items-center gap-1">
          {href && (
            <Button asChild size="sm">
              <a href={href}>Open phase</a>
            </Button>
          )}
          {onInspect && (
            <Button size="sm" variant="ghost" onClick={onInspect}>
              Inspect
            </Button>
          )}
          {onTrace && (
            <Button size="sm" variant="ghost" onClick={onTrace}>
              Trace
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
