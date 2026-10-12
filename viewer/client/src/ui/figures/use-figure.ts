/**
 * The interaction vocabulary every figure with an axis shares (control-tower
 * phase 29, #32 gap 2): a crosshair a keyboard can move, a readout it names,
 * and a zoom that never takes the page's own scroll away.
 *
 * The gesture policy is the part worth reading, because each rule is a thing
 * the obvious implementation gets wrong on a phone or a trackpad:
 *
 *   - **A plain wheel scrolls the page.** Only ⌃/⌘ + wheel zooms — which is
 *     also exactly what a trackpad pinch sends in Chrome, Edge and Firefox. A
 *     figure that ate the plain wheel would trap every reader whose pointer
 *     happened to rest on it on the way down the page.
 *   - **A vertical swipe scrolls the page.** The surface declares
 *     `touch-action: pan-y`: the browser keeps vertical panning, and hands us
 *     only what it will not do itself — a two-finger pinch and a sideways drag.
 *     `@visx/zoom` binds drag, pinch and wheel on its container and needs
 *     `touch-action: none` to see a pinch, which takes the page's scroll away
 *     over every figure; that is why the window lives here.
 *   - **The keyboard reaches everything a pointer does.** The crosshair is a
 *     `role="slider"` over the figure's stops: arrows step, Home/End jump, `+`
 *     and `-` zoom about the crosshair, `0` resets. Its `aria-valuetext` IS the
 *     readout, so a screen reader hears the datum a pointer would have seen.
 *
 * The figure supplies its geometry (`locate`) and its words (`describe`); this
 * hook owns only the state and the events, so the four figures and the run's
 * time axis cannot drift into four dialects of "zoom".
 */

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

import { panWindow, zoomOf, zoomWindow, type AxisWindow } from './scales';

/** Where a pointer is, in the figure's own terms. */
export type Located = {
  /** The position on the zoom axis — the focus a zoom keeps still. */
  at: number;
  /** The stop under the pointer, or `null` between stops. */
  stop: number | null;
};

export type ArrowKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown';

export interface FigureOptions {
  /** What the figure is, as its crosshair's accessible name. */
  label: string;
  /** How many stops the crosshair can rest on: bars, days, rows, segments. */
  count: number;
  /** The zoomable axis's whole extent, in its own units. */
  bounds: AxisWindow;
  /** The narrowest window that is still legible. */
  minSpan: number;
  /** The readout for stop `i` — the crosshair's value text. */
  describe: (index: number) => string;
  /** Pointer → figure terms. Absent until the drawing has a box to measure. */
  locate: (clientX: number, clientY: number, view: AxisWindow, surface: HTMLElement | null) => Located | null;
  /**
   * Where stop `i` sits on the zoom axis. A stop outside the window pans it in,
   * and the keyboard zooms about the crosshair rather than the middle. Absent
   * for a figure whose stops are not ON the zoom axis (BarList: rows vs values).
   */
  stopAt?: (index: number) => number;
  /** Arrow → stop delta. Default: Left/Down step back, Right/Up step on. */
  keySteps?: Partial<Record<ArrowKey, number>>;
  /** The stop a keyboard lands on first. Default: the last — the newest. */
  initialStop?: number;
}

const DEFAULT_STEPS: Record<ArrowKey, number> = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 };

/** One keypress or one wheel notch: twice as close, or half. */
const KEY_ZOOM = 2;
/** A wheel event's zoom is bounded, so a mouse's 100-pixel notch is not a leap. */
const WHEEL_MAX = 1.6;
/** Below this many pixels a touch is a tap, above it a drag. */
const TAP_SLOP = 8;

export function useFigure(options: FigureOptions) {
  const { bounds, minSpan, count } = options;
  const [view, setView] = useState<AxisWindow>(bounds);
  const [cursor, setCursor] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);

  // The data moves under a live figure (a week closes, a run grows): a window
  // that pointed at yesterday's extent is re-clamped rather than left showing
  // nothing, and an unzoomed one follows the data out to its new edge.
  const boundsKey = `${bounds[0]}:${bounds[1]}`;
  const lastBounds = useRef(boundsKey);
  useEffect(() => {
    if (lastBounds.current === boundsKey) return;
    const [was0, was1] = lastBounds.current.split(':').map(Number);
    lastBounds.current = boundsKey;
    setView((current) =>
      current[0] <= was0 && current[1] >= was1
        ? bounds
        : zoomWindow(current, 1, (current[0] + current[1]) / 2, bounds, minSpan),
    );
  }, [boundsKey, bounds, minSpan]);

  // The latest options, for listeners bound once.
  const live = useRef(options);
  live.current = options;
  const windowRef = useRef(view);
  windowRef.current = view;

  const clampStop = useCallback((i: number) => Math.min(Math.max(i, 0), Math.max(count - 1, 0)), [count]);

  const zoomBy = useCallback((factor: number, focus?: number) => {
    setView((current) =>
      zoomWindow(
        current,
        factor,
        focus ?? (current[0] + current[1]) / 2,
        live.current.bounds,
        live.current.minSpan,
      ),
    );
  }, []);

  const reset = useCallback(() => setView(live.current.bounds), []);

  /** Moves the crosshair, panning the window when the stop has left it. */
  const moveTo = useCallback(
    (index: number) => {
      const next = clampStop(index);
      setCursor(next);
      const at = live.current.stopAt?.(next);
      if (at === undefined) return;
      const [low, high] = windowRef.current;
      if (at < low) setView((w) => panWindow(w, at - w[0], live.current.bounds));
      else if (at > high) setView((w) => panWindow(w, at - w[1], live.current.bounds));
    },
    [clampStop],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (!count) return;
      const steps = { ...DEFAULT_STEPS, ...live.current.keySteps };
      const here = cursor ?? live.current.initialStop ?? count - 1;
      const focusAt = live.current.stopAt?.(here);
      let handled = true;
      if (event.key in steps) moveTo(here + steps[event.key as ArrowKey]);
      else if (event.key === 'Home') moveTo(0);
      else if (event.key === 'End') moveTo(count - 1);
      else if (event.key === '+' || event.key === '=') zoomBy(KEY_ZOOM, focusAt);
      else if (event.key === '-' || event.key === '_') zoomBy(1 / KEY_ZOOM, focusAt);
      else if (event.key === '0') reset();
      else handled = false;
      if (handled) event.preventDefault();
    },
    [count, cursor, moveTo, zoomBy, reset],
  );

  /* ---- the surface: wheel (native, so it can refuse the browser's zoom) ---- */

  const [surface, setSurface] = useState<HTMLElement | null>(null);
  const surfaceNode = useRef<HTMLElement | null>(null);
  const bindSurface = useCallback((node: HTMLElement | null) => {
    surfaceNode.current = node;
    setSurface(node);
  }, []);
  useEffect(() => {
    if (!surface) return;
    const onWheel = (event: WheelEvent) => {
      // A plain wheel is the page's. Only a modified one — or a trackpad pinch,
      // which arrives as one — is a zoom.
      if (!(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      const factor = Math.min(WHEEL_MAX, Math.max(1 / WHEEL_MAX, Math.exp(-event.deltaY / 100)));
      const place = live.current.locate(event.clientX, event.clientY, windowRef.current, surfaceNode.current);
      zoomBy(factor, place?.at);
    };
    surface.addEventListener('wheel', onWheel, { passive: false });
    return () => surface.removeEventListener('wheel', onWheel);
  }, [surface, zoomBy]);

  /* ---- the surface: pointers (pinch, sideways drag, hover, tap) ---- */

  const pointers = useRef(new Map<number, { x: number; y: number; x0: number; y0: number }>());
  const pinch = useRef<{ distance: number; window: AxisWindow; focus: number } | null>(null);
  const drag = useRef<{ x: number; window: AxisWindow } | null>(null);

  const spread = () => {
    const [a, b] = [...pointers.current.values()];
    return { distance: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  };

  const onPointerDown = (event: PointerEvent) => {
    pointers.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
      x0: event.clientX,
      y0: event.clientY,
    });
    if (pointers.current.size === 2) {
      const { distance, x, y } = spread();
      const focus =
        live.current.locate(x, y, windowRef.current, surfaceNode.current)?.at ??
        (windowRef.current[0] + windowRef.current[1]) / 2;
      pinch.current = { distance: Math.max(distance, 1), window: windowRef.current, focus };
      drag.current = null;
    } else if (pointers.current.size === 1 && zoomOf(windowRef.current, live.current.bounds) > 1) {
      drag.current = { x: event.clientX, window: windowRef.current };
    }
  };

  const onPointerMove = (event: PointerEvent) => {
    const held = pointers.current.get(event.pointerId);
    if (held) {
      held.x = event.clientX;
      held.y = event.clientY;
    }
    if (pinch.current && pointers.current.size >= 2) {
      const { distance } = spread();
      const start = pinch.current;
      setView(
        zoomWindow(
          start.window,
          distance / start.distance,
          start.focus,
          live.current.bounds,
          live.current.minSpan,
        ),
      );
      return;
    }
    if (drag.current && held) {
      // Sideways only: `pan-y` already gave the vertical part to the page.
      const from = live.current.locate(
        drag.current.x,
        event.clientY,
        drag.current.window,
        surfaceNode.current,
      )?.at;
      const to = live.current.locate(
        event.clientX,
        event.clientY,
        drag.current.window,
        surfaceNode.current,
      )?.at;
      if (from !== undefined && to !== undefined) {
        setView(panWindow(drag.current.window, from - to, live.current.bounds));
      }
      return;
    }
    // A hovering pointer reads the stop under it; a touch reads on a tap.
    if (event.pointerType !== 'touch') {
      const place = live.current.locate(event.clientX, event.clientY, windowRef.current, surfaceNode.current);
      if (place?.stop != null) setCursor(clampStop(place.stop));
    }
  };

  const release = (event: PointerEvent, tapped: boolean) => {
    const held = pointers.current.get(event.pointerId);
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (!pointers.current.size) drag.current = null;
    if (tapped && held && Math.hypot(event.clientX - held.x0, event.clientY - held.y0) < TAP_SLOP) {
      const place = live.current.locate(event.clientX, event.clientY, windowRef.current, surfaceNode.current);
      if (place?.stop != null) setCursor(clampStop(place.stop));
    }
  };

  const surfaceProps = {
    ref: bindSurface,
    onPointerDown,
    onPointerMove,
    onPointerUp: (event: PointerEvent) => release(event, true),
    // The browser took the gesture (a vertical swipe became the page's scroll).
    onPointerCancel: (event: PointerEvent) => release(event, false),
    onPointerLeave: (event: PointerEvent) => {
      if (event.pointerType !== 'touch' && !focused) setCursor(null);
    },
    style: { touchAction: 'pan-y' as const },
  };

  const shown = cursor ?? options.initialStop ?? Math.max(count - 1, 0);
  const sliderProps = {
    role: 'slider' as const,
    tabIndex: count ? 0 : -1,
    'aria-label': options.label,
    'aria-valuemin': 0,
    'aria-valuemax': Math.max(count - 1, 0),
    'aria-valuenow': shown,
    'aria-valuetext': count ? options.describe(shown) : 'nothing to read',
    onKeyDown,
    onFocus: () => {
      setFocused(true);
      if (cursor === null && count) setCursor(shown);
    },
    onBlur: () => setFocused(false),
  };

  const zoom = zoomOf(view, bounds);
  return { view, zoom, zoomed: zoom > 1.001, cursor, setCursor, zoomBy, reset, surfaceProps, sliderProps };
}

export type Figure = ReturnType<typeof useFigure>;
