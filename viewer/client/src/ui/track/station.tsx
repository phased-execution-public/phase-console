import type { LiHTMLAttributes, ReactNode } from 'react';
import type { UiState } from '@shared/status-vocab.js';
import { cn } from '@/lib/cn';

/**
 * A station on the line (design.md §7): a dot painted through `.state-<paint>`
 * and the identity of its record beside it — colour is never the only carrier.
 *
 * Four things a station can be, each a data attribute a stylesheet or a test
 * reads. `settled`: over — a hollow dot that has lost its hue, unless it is
 * `failed`, which keeps the red. `live`: observed live right now — the only
 * thing on a page that may breathe, and only when painted `running`.
 * `needs-you` wears the summons ring, never a pulse: a gate waiting on a
 * person is not alive. `fill` paints the segment after this station in its
 * own state (a ticked step, a leg already travelled).
 *
 * A station can also be a TICK — a person's own mark of where they are, as a
 * guide's step is (`cards/guide.tsx`): the dot becomes a real checkbox under a
 * drawn station that carries the step's number, and ticking it is the
 * caller's to paint (`paint`, `fill`). The tick says nothing to the console;
 * a check, not a tick, says a thing is done.
 */
export interface StationTick {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** What ticking says, read by a screen reader — "Step 2 done". */
  label: string;
  /** What the drawn station shows: the step's number. Decoration — the label says it. */
  face?: ReactNode;
  /** The hover title — what pressing the station does. */
  title?: string;
}

export interface StationProps extends Omit<LiHTMLAttributes<HTMLLIElement>, 'children'> {
  paint: UiState;
  /** The station's identity beside its dot — a number, a name, a word. */
  children?: ReactNode;
  settled?: boolean;
  live?: boolean;
  fill?: boolean;
  /** The dot as a control: the person's own tick. */
  tick?: StationTick;
}

export function Station({
  paint,
  children,
  settled = false,
  live = false,
  fill = false,
  tick,
  className,
  ...props
}: StationProps) {
  const pulses = live && paint === 'running';
  const summons = paint === 'needs-you';
  return (
    <li
      data-station
      data-state={paint}
      data-settled={settled ? '' : undefined}
      data-live={pulses ? '' : undefined}
      data-summons={summons ? '' : undefined}
      data-fill={fill ? '' : undefined}
      data-ticked={tick ? String(tick.checked) : undefined}
      className={cn('ui-station', `state-${paint}`, className)}
      {...props}
    >
      {tick ? (
        <label className="ui-station-tick" title={tick.title}>
          <input
            type="checkbox"
            className="ui-station-tick-input"
            checked={tick.checked}
            onChange={(event) => tick.onChange(event.target.checked)}
            aria-label={tick.label}
          />
          <span aria-hidden className="ui-station-tick-face">
            {tick.face}
          </span>
        </label>
      ) : (
        <i aria-hidden className="ui-station-dot" />
      )}
      {children != null && <div className="ui-station-label">{children}</div>}
    </li>
  );
}
