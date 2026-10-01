/**
 * Two facts about this process that node does not hand over as a number.
 *
 * Both are optional on purpose. A build that cannot answer reports `undefined`
 * and its gauge simply does not emit — because "no handle count available" and
 * "no handles open" are different facts, and a metric that cannot tell them
 * apart is worse than one that is absent.
 */

import { monitorEventLoopDelay } from 'node:perf_hooks';

import { log } from './log.ts';

/**
 * The window event-loop delay is reported over (control-tower phase 56, #75).
 *
 * The gauge used to be the histogram's MEAN since boot — and a mean since
 * boot cannot show a stall: the 4.6-minute silence of 2026-09-22 12:11Z was
 * one sample among days of healthy ones. So the histogram is rotated on this
 * clock and read as the last complete window's max and p99.
 */
export const LOOP_DELAY_WINDOW_MS = 60_000;

/** A window whose max is at least this long is a stall worth a log line. */
export const LOOP_STALL_WARN_MS = 1_000;

/** The part of node's `IntervalHistogram` a window reads — nanoseconds. */
export type DelayHistogram = {
  readonly max: number;
  readonly mean: number;
  percentile(p: number): number;
  reset(): void;
};

/** One window's figures, in seconds. */
export type LoopDelayReading = {
  maxSeconds: number;
  p99Seconds: number;
  meanSeconds: number;
  /** How long the window ran — at least `LOOP_DELAY_WINDOW_MS` once one has closed. */
  windowMs: number;
};

/**
 * A delay histogram read in windows. `reading()` answers the last COMPLETE
 * window — so a stall stays visible for a whole window after it ended rather
 * than being averaged away — and the window still running until one closes.
 */
export class LoopDelayWindow {
  private readonly histogram: DelayHistogram;
  private readonly now: () => number;
  private readonly windowMs: number;
  private readonly onClose: (reading: LoopDelayReading) => void;
  private since: number;
  private last: LoopDelayReading | null = null;

  constructor(
    histogram: DelayHistogram,
    options: { now?: () => number; windowMs?: number; onClose?: (reading: LoopDelayReading) => void } = {},
  ) {
    this.histogram = histogram;
    this.now = options.now ?? Date.now;
    this.windowMs = options.windowMs ?? LOOP_DELAY_WINDOW_MS;
    this.onClose = options.onClose ?? (() => undefined);
    this.since = this.now();
  }

  /** Close the running window if it has run its length. Idempotent inside a window. */
  rotate(): void {
    const at = this.now();
    if (at - this.since < this.windowMs) return;
    const closed = this.current(at);
    this.histogram.reset();
    this.since = at;
    if (!closed) return;
    this.last = closed;
    this.onClose(closed);
  }

  reading(): LoopDelayReading | undefined {
    this.rotate();
    return this.last ?? this.current(this.now()) ?? undefined;
  }

  /** The running window, or null when it holds no sample yet. */
  private current(at: number): LoopDelayReading | null {
    const { max, mean } = this.histogram;
    if (!Number.isFinite(mean) || !Number.isFinite(max) || max <= 0) return null;
    return {
      maxSeconds: max / 1e9,
      p99Seconds: this.histogram.percentile(99) / 1e9,
      meanSeconds: mean / 1e9,
      windowMs: at - this.since,
    };
  }
}

/**
 * The live histogram, started once.
 *
 * Sampled continuously rather than measured per scrape: a `setTimeout` round
 * trip taken at scrape time measures the moment the scrape ran, which is the
 * one moment the loop is certainly busy with the scrape. The monitor holds no
 * handle that keeps the process alive; the rotation clock is unref'd.
 */
const loopDelay = (() => {
  try {
    const monitor = monitorEventLoopDelay({ resolution: 20 });
    monitor.enable();
    const window = new LoopDelayWindow(monitor, {
      onClose: (reading) => {
        if (reading.maxSeconds * 1000 < LOOP_STALL_WARN_MS) return;
        log.warn('process.loop-stall', {
          maxMs: Math.round(reading.maxSeconds * 1000),
          p99Ms: Math.round(reading.p99Seconds * 1000),
          windowMs: reading.windowMs,
        });
      },
    });
    setInterval(() => window.rotate(), LOOP_DELAY_WINDOW_MS).unref();
    return window;
  } catch {
    return null;
  }
})();

/** The last complete window's delay, or `undefined` where node cannot measure it. */
export function eventLoopDelay(): LoopDelayReading | undefined {
  return loopDelay?.reading();
}

/** The window's MEAN — what the original gauge reported, now over the window. */
export function eventLoopDelaySeconds(): number | undefined {
  return eventLoopDelay()?.meanSeconds;
}

export function activeHandles(): number | undefined {
  const get = (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles;
  if (typeof get !== 'function') return undefined;
  try {
    return get.call(process).length;
  } catch {
    return undefined;
  }
}
