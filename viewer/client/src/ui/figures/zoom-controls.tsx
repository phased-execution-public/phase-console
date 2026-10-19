/**
 * A time figure's zoom, said on the figure (one-pool phase 16, #376): − / +
 * and — on a run's axis — quick ranges; the way back stays the figure's own
 * *Reset zoom* beside its readout. Before this the zoom was
 * ⌃/⌘ + wheel or `+` / `-` / `0` on a focused figure, and nothing on the page
 * said so; *Reset zoom* appeared only once zoomed.
 *
 * ```
 * Zoom [−] [+]   Last hour · 6 h · 24 h · All      ×2.0 · ⌃ or ⌘ + wheel zooms too
 * ```
 *
 * The run timeline keeps its window in the address as `?zoom=`: a quick range
 * by its token (`1h`, `6h`, `24h`; `all` is the address without one), or a
 * window as `<from>~<to>` in whole seconds from the axis's start. The buttons
 * write it; a wheel or a pinch does not — every notch would be a history entry.
 */

import { Button } from '@/ui';
import { cn } from '@/lib/cn';
import type { AxisWindow } from './scales';
import type { Figure } from './use-figure';

/** The quick ranges a run's axis offers: the last stretch of it, by its token. */
export const QUICK_RANGES = [
  { token: '1h', label: 'Last hour', ms: 3_600_000 },
  { token: '6h', label: '6 h', ms: 6 * 3_600_000 },
  { token: '24h', label: '24 h', ms: 24 * 3_600_000 },
] as const;

/** The window a `?zoom=` asks for on an axis of `spanMs`, or `null` for the whole axis (or a word it does not know). */
export function zoomWindowOf(param: string | undefined, spanMs: number): AxisWindow | null {
  if (!param || param === 'all' || !(spanMs > 0)) return null;
  const quick = QUICK_RANGES.find((range) => range.token === param);
  if (quick) return quick.ms >= spanMs ? null : [spanMs - quick.ms, spanMs];
  const match = /^(\d+)~(\d+)$/.exec(param);
  if (!match) return null;
  const from = Number(match[1]) * 1000;
  const to = Math.min(spanMs, Number(match[2]) * 1000);
  return to > from ? [from, to] : null;
}

/** A window as the address writes it — `null` for the whole axis. */
export function zoomParamOf(window: AxisWindow, spanMs: number): string | null {
  if (window[0] <= 0 && window[1] >= spanMs) return null;
  return `${Math.floor(window[0] / 1000)}~${Math.ceil(window[1] / 1000)}`;
}

/** One zoom step of the buttons: twice as close, or half — the keyboard's own. */
const STEP = 2;

export function ZoomControls({
  figure,
  spanMs,
  quick = false,
  current,
  onZoom,
  className,
}: {
  figure: Figure;
  /** The axis's whole span, in ms. */
  spanMs: number;
  /** Offer the run's quick ranges. */
  quick?: boolean;
  /** The `?zoom=` on show, for the quick range a press marks. */
  current?: string | undefined;
  /** Writes the zoom to the address (the run timeline); absent, the zoom stays the figure's own. */
  onZoom?: (param: string | null) => void;
  className?: string;
}) {
  const write = (window: AxisWindow) => onZoom?.(zoomParamOf(window, spanMs));
  const step = (factor: number) => {
    const [a, b] = figure.view;
    const span = Math.max(1, (b - a) / factor);
    const mid = (a + b) / 2;
    const next: AxisWindow = [Math.max(0, mid - span / 2), Math.min(spanMs, mid + span / 2)];
    figure.zoomBy(factor);
    write(next);
  };
  const ranges = quick ? QUICK_RANGES.filter((range) => range.ms < spanMs) : [];
  return (
    <div
      role="group"
      aria-label="Zoom"
      data-testid="zoom-controls"
      className={cn(
        'flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-meta text-ink-muted',
        className,
      )}
    >
      <span className="flex items-center gap-1">
        <span className="me-1">Zoom</span>
        <Button
          size="sm"
          variant="ghost"
          aria-label="Zoom out"
          onClick={() => step(1 / STEP)}
          disabled={!figure.zoomed}
        >
          −
        </Button>
        <Button size="sm" variant="ghost" aria-label="Zoom in" onClick={() => step(STEP)}>
          +
        </Button>
      </span>
      {ranges.length > 0 && (
        <span className="flex flex-wrap items-center gap-1" role="group" aria-label="Quick ranges">
          {ranges.map((range) => (
            <Button
              key={range.token}
              size="sm"
              variant="ghost"
              aria-pressed={current === range.token}
              className={cn(current === range.token && 'text-ink')}
              onClick={() => {
                figure.zoomTo([spanMs - range.ms, spanMs]);
                onZoom?.(range.token);
              }}
            >
              {range.label}
            </Button>
          ))}
          <Button
            size="sm"
            variant="ghost"
            aria-pressed={!current || current === 'all'}
            onClick={() => {
              figure.reset();
              onZoom?.(null);
            }}
          >
            All
          </Button>
        </span>
      )}
      <span className="tnum">
        {figure.zoomed ? `×${figure.zoom.toFixed(1)} · ` : ''}⌃ or ⌘ + wheel zooms too
      </span>
    </div>
  );
}
