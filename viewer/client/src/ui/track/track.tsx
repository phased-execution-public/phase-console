import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';
import './track.css';

/**
 * The line — the console's one graphic (design.md §7). A plan is a line and
 * its phases are stations; the same grammar draws a run row's phase track, a
 * guide's step track and the phase table's spine. The line itself is NEUTRAL
 * (`--track`); only a station carries a state.
 *
 * A list, because it is one: each station is an item with its own identity
 * beside its dot, so a screen reader hears "station 3 of 12, Verifying" and
 * never a row of colours. `role="list"` is restated because `list-style: none`
 * drops the semantics in one engine.
 */
export type TrackOrientation = 'horizontal' | 'vertical';

/**
 * Where a vertical station's mark sits beside what it carries: centred, for a
 * label of a line or two (the phase spine), or at its START, for a station
 * that carries a task — a guide step with a command, an expectation and a
 * warning — whose mark belongs beside its first line. A start-aligned track
 * draws its line leg by leg, from each mark to the next, so the line never runs
 * on past the last station into what it carries.
 */
export type TrackAlign = 'center' | 'start';

export function Track({
  orientation = 'horizontal',
  align = 'center',
  label,
  className,
  children,
  ...props
}: {
  orientation?: TrackOrientation;
  /** Vertical tracks only — see `TrackAlign`. */
  align?: TrackAlign;
  /** What this line is a line OF — "Phases", "Steps". The list's accessible name. */
  label?: string;
  children: ReactNode;
} & Omit<HTMLAttributes<HTMLOListElement>, 'children'>) {
  return (
    <ol
      role="list"
      data-track
      data-orientation={orientation}
      data-align={orientation === 'vertical' && align === 'start' ? 'start' : undefined}
      aria-label={label}
      className={cn('ui-track', className)}
      {...props}
    >
      {children}
    </ol>
  );
}
