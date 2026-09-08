/**
 * The route map — the plan as a transit network.
 *
 * Phases are stations, dependencies are track, and each session batch the
 * engine suggests is drawn as a train threading the stations it carries.
 * Columns come from the server's longest-path layering, rows from its
 * barycentre ordering, so the same plan always draws the same way.
 *
 * ---- The three things a station has to say ----
 *
 * WHAT state it is in, WHO is driving it, and WHERE the work flows. Each is a
 * separate mark, and none of them is a colour:
 *
 *   - the state is the ring treatment plus a drawn glyph in a chip at the
 *     station's top right — a check, a play triangle, a double chevron, an
 *     hourglass, an exclamation. Hue rides along through `--state`, set by the
 *     `.state-<ui>` class, but nothing depends on it: the map is readable in
 *     greyscale, which is WCAG 1.4.1 and is also what a photocopy of a plan
 *     looks like.
 *   - the driver is a second chip at the bottom right, carrying the sessions
 *     page's own icon for the vehicle. It is drawn only over an OBSERVED live
 *     fact, and it is what licenses the pulse: `in-progress` is a word out of a
 *     markdown file and a word must not breathe.
 *   - direction is an arrowhead on every track, because left-to-right is a
 *     convention a reader has to be told once and a map should simply say.
 *
 * ---- What is a port and what is new ----
 *
 * The layout constants, the zoom-about-a-point algebra, the drag/pinch state
 * machine and the `MIN_K` derivation are `web/components/dag.js` verbatim: they
 * were arrived at against a real phone and a real plan, and re-deriving them
 * from taste would lose that. The view state and the gestures are a hook
 * (`useMapView`) that knows nothing about stations, and the SVG is a component
 * that knows nothing about pointers.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Lock, Unlock, X } from 'lucide-react';
import { ACTOR_ICON } from '@/components/actor-icon';
import { Button, ButtonGroup, Legend, asPhaseState, type PhaseState } from '@/components/ui';
import { PHASE_ACTOR_LABELS, STATE_META, boardLabel, boardUiState, type UiState } from '@/lib/status-vocab';
import { weight } from '@/lib/format';
import { cn } from '@/lib/cn';
import { useNarrow, useTouch } from '@/lib/media';
import { usePrefs } from '@/lib/prefs';
import type {
  BatchGroup,
  PhaseActor,
  PhaseLive,
  PhaseLock,
  RouteNode,
  RouteView,
  SessionPlanView,
} from '@/lib/api';

/* ------------------------------------------------------------------ *
 * Geometry
 * ------------------------------------------------------------------ */

const COL_W = 178;
const ROW_H = 108;
const PAD = 58;
const R = 15;

/** A finger's worth of station, in CSS pixels. */
const TAP = 44;

/**
 * The zoom floor is a touch decision, not a taste one.
 *
 * Rows are `ROW_H` apart, so a 44px target stops overlapping its neighbour
 * above only once 44/k < ROW_H — that is k > 0.407. The old floor was 0.25,
 * which drew ~10px stations with 4px labels and put three of them inside one
 * thumb. At 0.45 the whole map may not fit a phone at once, which is fine:
 * a map you pan is a map, and a map you cannot hit is a picture.
 *
 * It is the floor on the MANUAL zoom only. A fit is not a zoom the operator
 * chose, it is the answer to "show me the plan" — clamping it here is what
 * made a fifteen-layer plan open at 0.45 with two thirds of itself outside the
 * frame and no indication there was more.
 */
const MIN_K = 0.45;
const MAX_K = 2.4;
const FIT_MAX_K = 1.6;
/** A fit still may not reach zero, or the viewBox divides by it. */
const FIT_MIN_K = 0.06;

/**
 * One zoom step, for every control that zooms.
 *
 * The wheel used to step 0.92/1.08 and the buttons 0.9/1.1, so a wheel notch
 * and a button press disagreed about how much "closer" is — and neither pair
 * was each other's reciprocal, so out-then-in did not return. One factor, and
 * out is its reciprocal.
 */
const ZOOM_STEP = 1.1;

/** Exported for the test that re-derives the floor from the two it depends on. */
export const MAP_CONSTANTS = {
  COL_W,
  ROW_H,
  PAD,
  R,
  TAP,
  MIN_K,
  MAX_K,
  FIT_MIN_K,
  FIT_MAX_K,
  ZOOM_STEP,
};

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/** Two decimals is more than a screen can show and keeps the DOM from churning. */
const n2 = (value: number) => Math.round(value * 100) / 100;

export interface PlacedNode extends RouteNode {
  x: number;
  y: number;
}

export interface Layout {
  points: Map<number, PlacedNode>;
  width: number;
  height: number;
}

/** Layer → column, row → row, both in plan coordinates. */
export function positions(route: RouteView): Layout {
  const byLayer = new Map<number, RouteNode[]>();
  for (const node of route.nodes) {
    if (!byLayer.has(node.layer)) byLayer.set(node.layer, []);
    byLayer.get(node.layer)!.push(node);
  }
  const maxRows = Math.max(1, ...[...byLayer.values()].map((list) => list.length));

  const points = new Map<number, PlacedNode>();
  for (const [layer, list] of byLayer) {
    const offset = (maxRows - list.length) / 2;
    for (const node of list) {
      points.set(node.phase, {
        ...node,
        x: PAD + layer * COL_W,
        y: PAD + (offset + node.row) * ROW_H,
      });
    }
  }
  return {
    points,
    // Labels are centred under their station, so the last column needs room
    // for half a label past the node itself.
    width: PAD * 2 + Math.max(0, route.layers - 1) * COL_W + 60,
    /* The last row's stations sit at `PAD + (maxRows-1) * ROW_H`, so this box
       already carries a whole PAD below them — 58 units against the ~43 a
       two-line label drops. The content box needs no further allowance, and
       adding one (there used to be a `LABEL_DROP` of 40) made every fit 15-26%
       too small and pushed the centring 20 units off. */
    height: PAD * 2 + Math.max(0, maxRows - 1) * ROW_H,
  };
}

/**
 * One edge, resolved to everything the paint needs and nothing that moves.
 *
 * The path string and the stagger index depend only on the route; the `dim`
 * flag depends on what the pointer is over. Keeping them apart is what lets the
 * geometry be memoised across a hover.
 */
interface DrawnEdge {
  key: string;
  /** Phase numbers, kept so the dim test can be applied at render time. */
  from: number;
  to: number;
  done: boolean;
  d: string;
  /** The draw-in stagger column, already capped. */
  i: number;
}

/**
 * Is this edge outside the neighbourhood the pointer is asking about?
 *
 * `related` is the highlighted station plus its DIRECT neighbours, so every
 * edge touching it already has both ends inside; what this dims is the edges
 * between two other stations, which is the whole point of highlighting. Both
 * ends must be in, and the expression says so — it is the previous inline one,
 * moved out unchanged.
 */
const dimEdge = (related: Set<number> | null, edge: DrawnEdge): boolean =>
  Boolean(related) && !(related!.has(edge.from) && related!.has(edge.to));

/** One column of the board — a layer of the engine's layering, ruled. */
export interface Platform {
  /** The engine's longest-path layer. Zero-based, as the route reports it. */
  layer: number;
  /** Plan-x of the wave's edges. They TILE: each one's right is the next one's left. */
  left: number;
  right: number;
  /** How many stations stand on this platform. */
  count: number;
}

/**
 * The columns the stations stand in, as edges to rule between.
 *
 * `positions()` puts a phase in a column by its LONGEST-PATH LAYER — the number
 * of dependency hops that must complete before it can start, which is the
 * earliest wave it could possibly run in. That number decides every station's
 * x, and until now the map never printed it: the strongest structural fact on
 * screen was the one thing a reader had to reconstruct by counting columns.
 *
 * They tile the whole drawing rather than stopping at their stations, so the
 * INTERIOR boundaries — the only ones that get a hairline — fall at the
 * midpoint between two columns rather than at an arbitrary offset from one. The
 * first runs out to the left margin and the last to `width`; neither of those
 * edges is ruled, because a rule at the margin is a border rather than a
 * ruling. (They were drawn as alternating fills for one QA round; see
 * `route-map.css` for why one paper is the requirement, not the taste.)
 *
 * ⚠️ A wave is NOT "these run together". Two phases in one layer may share a
 * repo, and the map does not know their scopes — the engine's `--session-plan`
 * is what answers that, and its answer is the trains. This says only: nothing
 * in wave N can start until N waves of work are behind it.
 *
 * Pure, and exported, for the same reason `positions` is: jsdom computes no
 * styles, so a geometry promise is asserted as arithmetic or not at all.
 */
export function platforms(route: RouteView, width: number): Platform[] {
  if (!route.nodes.length) return [];
  const counts = new Map<number, number>();
  for (const node of route.nodes) counts.set(node.layer, (counts.get(node.layer) ?? 0) + 1);
  const last = Math.max(0, route.layers - 1);
  const bands: Platform[] = [];
  for (let layer = 0; layer <= last; layer++) {
    bands.push({
      layer,
      left: layer === 0 ? 0 : PAD + layer * COL_W - COL_W / 2,
      right: layer === last ? width : PAD + layer * COL_W + COL_W / 2,
      count: counts.get(layer) ?? 0,
    });
  }
  return bands;
}

/** Orthogonal track with rounded corners, drawn from one station to the next. */
export function trackPath(from: PlacedNode, to: PlacedNode): string {
  const x1 = from.x + R + 4;
  const x2 = to.x - R - 8;
  if (Math.abs(from.y - to.y) < 1) return `M${x1},${from.y} L${x2},${to.y}`;

  const mid = x1 + Math.max(22, (x2 - x1) / 2);
  const down = to.y > from.y ? 1 : -1;
  const curve = Math.min(14, Math.abs(to.y - from.y) / 2);
  return [
    `M${x1},${from.y}`,
    `L${mid - curve},${from.y}`,
    `Q${mid},${from.y} ${mid},${from.y + curve * down}`,
    `L${mid},${to.y - curve * down}`,
    `Q${mid},${to.y} ${mid + curve},${to.y}`,
    `L${x2},${to.y}`,
  ].join(' ');
}

/**
 * How much of a fifteen-layer plan draws itself in.
 *
 * The track draw-in is staggered by column so the map reads as a network being
 * laid rather than as forty lines appearing at once. Uncapped, a 15-layer plan
 * spent 15 × 70ms + the draw itself before the last edge existed — over a
 * second and a half of a page that looked broken. Capped, the whole animation
 * lands inside `STAGGER_CAP × 70ms + --duration-draw`.
 */
const STAGGER_CAP = 8;

/* ------------------------------------------------------------------ *
 * The window onto the map
 * ------------------------------------------------------------------ */

export interface MapView {
  /** Plan units per CSS pixel. */
  k: number;
  /** The plan point at the frame's top-left corner. */
  x: number;
  y: number;
}

export interface Box {
  w: number;
  h: number;
}

/**
 * The scale at which the whole plan fits the frame.
 *
 * Bounded ABOVE only — `FIT_MAX_K` stops a two-phase plan ballooning to
 * cartoon stations — plus the epsilon floor that keeps the viewBox finite.
 */
export function fitScale(frame: Box, content: Box): number {
  const k = Math.min(frame.w / Math.max(content.w, 1), frame.h / Math.max(content.h, 1));
  return clamp(k, FIT_MIN_K, FIT_MAX_K);
}

/**
 * Keep the window over the drawing.
 *
 * An unclamped "look at this station" is what let the map open on empty paper:
 * `centreOn` put a corner station in the middle of the frame, which puts most
 * of the frame outside the content box. An axis the window is wider than is
 * centred rather than clamped — there is nothing to pan to on it.
 */
export function clampView(view: MapView, frame: Box, content: Box): MapView {
  const vw = frame.w / view.k;
  const vh = frame.h / view.k;
  return {
    k: view.k,
    x: vw >= content.w ? (content.w - vw) / 2 : clamp(view.x, 0, content.w - vw),
    y: vh >= content.h ? (content.h - vh) / 2 : clamp(view.y, 0, content.h - vh),
  };
}

/** The window at `k`, looking at a plan point — the content's middle by default. */
export function centreView(k: number, frame: Box, content: Box, at?: { x: number; y: number }): MapView {
  const cx = at?.x ?? content.w / 2;
  const cy = at?.y ?? content.h / 2;
  return clampView({ k, x: cx - frame.w / k / 2, y: cy - frame.h / k / 2 }, frame, content);
}

/**
 * The frame's size in CSS pixels, kept current.
 *
 * Measured in a LAYOUT effect, and seeded from the node if one is already
 * attached. The old `useEffect` produced a three-paint open that the operator
 * saw every time: paint 1 drew the viewBox fallback (which looks fitted), paint
 * 2 had the size but the fit effect had already run on that pass — so the map
 * flashed at 1:1 in its top-left corner — and paint 3 finally fitted.
 *
 * `setSize` is equality-guarded because a ResizeObserver fires on every
 * sub-pixel settle, and this state re-renders an SVG of every station.
 */
function useFrameSize(ref: React.RefObject<HTMLDivElement | null>) {
  const [size, setSize] = useState<Box>(() => ({
    w: ref.current?.clientWidth ?? 0,
    h: ref.current?.clientHeight ?? 0,
  }));
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    const measure = () =>
      setSize((prev) =>
        prev.w === node.clientWidth && prev.h === node.clientHeight
          ? prev
          : { w: node.clientWidth, h: node.clientHeight },
      );
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

/**
 * Pan, pinch and zoom over a fixed frame.
 *
 * `view` is the window onto the plan, in plan coordinates. It used to be a
 * `scale()` transform on a `<g>` inside an SVG with no `viewBox` at all — so the
 * drawing's coordinate system was "whatever pixel size the element happened to
 * have", the SVG grew taller as you zoomed in, and "fit" was a guess at a scale
 * rather than a statement about a rectangle. A viewBox says the thing directly:
 * this is the part of the map you can see.
 *
 * ---- Whose viewport is it ----
 *
 * The map's, until the operator moves it. Opening a plan fits it and then looks
 * at the one station the caller named, ONCE; a container resize refits, because
 * a window that changed shape has no remembered viewport to protect. The first
 * drag, pinch or zoom flips `touched` and every automatic move stops: after
 * that the viewport is the operator's, and only Fit (or a double-click on the
 * background, which is the same gesture) gives it back.
 */
export function useMapView({
  width,
  contentH,
  fitKey,
  focusPoint,
  interactive = true,
}: {
  width: number;
  contentH: number;
  /** Changes when the drawing changes — a new plan refits, a resize does not. */
  fitKey: string;
  /**
   * The plan point to look at when a plan opens. Read through a ref, so a
   * focus that moves — and it moves whenever the run stream ticks — never
   * yanks a viewport the operator is reading.
   */
  focusPoint?: { x: number; y: number } | null;
  /**
   * Whether the wheel, drag and pinch gestures are live. Off means the map is
   * a picture the page scrolls past — the wheel listener is simply never
   * attached and pointers are ignored — while `fit`, `zoomCentre` and the
   * initial auto-fit keep working, so the toolbar buttons always do.
   */
  interactive?: boolean;
}) {
  const [view, setView] = useState<MapView>({ k: 1, x: 0, y: 0 });
  const frame = useRef<HTMLDivElement>(null);
  const size = useFrameSize(frame);
  const content = useMemo<Box>(() => ({ w: width, h: contentH }), [width, contentH]);

  // Live pointers by id — two of them is a pinch, one is a drag.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<
    { kind: 'drag'; x: number; y: number } | { kind: 'pinch'; dist: number; k: number } | null
  >(null);
  // A drag that passes over a station must not also count as choosing it.
  const dragged = useRef(false);
  /** Set once the operator has moved the map themselves; cleared by Fit. */
  const touched = useRef(false);

  const focusRef = useRef(focusPoint);
  focusRef.current = focusPoint;

  const fitView = useCallback(
    (at?: { x: number; y: number } | null) => {
      setView((v) => {
        if (!size.w || !size.h) return v;
        return centreView(fitScale(size, content), size, content, at ?? undefined);
      });
    },
    [size, content],
  );

  /*
   * One effect owns every automatic move, so the open and the resize cannot
   * race each other. `framed` is what tells the two apart: a fitKey that has
   * not been opened is an open (fit, then look at the focus point); a frame
   * whose measurements changed is a resize.
   */
  const opened = useRef<string | null>(null);
  const framed = useRef<Box>({ w: 0, h: 0 });
  useLayoutEffect(() => {
    if (!size.w || !size.h) return;
    const fresh = opened.current !== fitKey;
    const resized = framed.current.w !== size.w || framed.current.h !== size.h;
    if (!fresh && !resized) return;
    framed.current = { w: size.w, h: size.h };
    if (fresh) {
      opened.current = fitKey;
      touched.current = false;
      fitView(focusRef.current);
      return;
    }
    if (!touched.current) fitView();
  }, [fitKey, size.w, size.h, fitView]);

  /** Zoom about a point in the frame, so what is under the finger stays there. */
  const zoomAt = useCallback((px: number, py: number, next: (k: number) => number) => {
    setView((v) => {
      const k = clamp(next(v.k), MIN_K, MAX_K);
      if (k === v.k) return v;
      touched.current = true;
      return { k, x: v.x + px / v.k - px / k, y: v.y + py / v.k - py / k };
    });
  }, []);

  const local = useCallback((clientX: number, clientY: number) => {
    const rect = frame.current?.getBoundingClientRect();
    return rect ? { px: clientX - rect.left, py: clientY - rect.top } : { px: 0, py: 0 };
  }, []);

  /**
   * The wheel listener is native, not a React prop — and that is the one place
   * this port could not be verbatim.
   *
   * React registers `wheel` on its root container as **passive**, so a
   * `preventDefault()` inside `onWheel` does nothing but log a warning, and the
   * page scrolls away underneath a map you were trying to zoom. The old client
   * used Preact, which binds handlers to the element itself and is therefore
   * non-passive by default. `{ passive: false }` here restores the old
   * behaviour exactly.
   */
  useEffect(() => {
    const node = frame.current;
    // Locked: no listener at all — a `preventDefault` that never runs is what
    // lets the page scroll natively over the map.
    if (!node || !interactive) return undefined;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const { px, py } = local(event.clientX, event.clientY);
      const factor = event.deltaY > 0 ? 1 / ZOOM_STEP : ZOOM_STEP;
      zoomAt(px, py, (k) => k * factor);
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, [local, zoomAt, interactive]);

  // A toggle mid-gesture must not strand a half-finished drag or pinch: the
  // next unlock would resume a gesture whose fingers left long ago.
  useEffect(() => {
    if (interactive) return;
    pointers.current.clear();
    gesture.current = null;
    dragged.current = false;
  }, [interactive]);

  const startDrag = (clientX: number, clientY: number) => {
    gesture.current = { kind: 'drag', x: clientX, y: clientY };
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!interactive) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    dragged.current = false;
    // Capture keeps a drag alive past the edge of the frame. It throws rather
    // than no-ops when the id is not an active pointer, and an exception here
    // would take the rest of the gesture with it.
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      /* not capturable */
    }

    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current = { kind: 'pinch', dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, k: view.k };
    } else if (pointers.current.size === 1) {
      startDrag(event.clientX, event.clientY);
    }
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const active = gesture.current;
    if (!active) return;

    if (active.kind === 'pinch' && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const spread = Math.hypot(a.x - b.x, a.y - b.y);
      const { px, py } = local((a.x + b.x) / 2, (a.y + b.y) / 2);
      dragged.current = true;
      zoomAt(px, py, () => active.k * (spread / active.dist));
      return;
    }

    if (active.kind === 'drag') {
      const dx = event.clientX - active.x;
      const dy = event.clientY - active.y;
      active.x = event.clientX;
      active.y = event.clientY;
      if (Math.abs(dx) + Math.abs(dy) > 2) dragged.current = true;
      touched.current = true;
      setView((v) => ({ ...v, x: v.x - dx / v.k, y: v.y - dy / v.k }));
    }
  };

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size === 0) {
      gesture.current = null;
      return;
    }
    // A pinch that loses one finger becomes a drag with the one left, rather
    // than a dead gesture you have to lift and start again.
    const [rest] = [...pointers.current.values()];
    startDrag(rest.x, rest.y);
  };

  /*
   * A pointer that leaves the frame WITHOUT capture ends its gesture here.
   * `setPointerCapture` throws for a pointer the element is not tracking (and
   * simply does not exist in jsdom), and the catch around it left the gesture
   * alive with no `pointerup` coming — the map then panned on every subsequent
   * mouse move, with no button held, until you clicked it again.
   */
  const onPointerLeave = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) return;
    onPointerUp(event);
  };

  const fit = () => {
    touched.current = false;
    fitView();
  };

  /**
   * Zoom about the middle of what is currently drawn.
   *
   * The fallbacks mirror the viewBox's own: before the frame is measured the
   * window IS the content box, so its middle is the content's middle in frame
   * pixels. Reading the unmeasured size as 0 put the anchor in the top-left
   * corner instead, and the map crawled away from the corner on every press.
   */
  const zoomCentre = (factor: number) =>
    zoomAt((size.w || width * view.k) / 2, (size.h || contentH * view.k) / 2, (k) => k * factor);

  return {
    frame,
    view,
    size,
    fit,
    zoomCentre,
    /** Read at click time: a drag that crossed a station is not a tap on it. */
    dragged,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
      onPointerLeave,
    },
  };
}

/* ------------------------------------------------------------------ *
 * The station mark — state without colour
 * ------------------------------------------------------------------ */

/**
 * Every ring and chip on a station, derived from its radius.
 *
 * Derived rather than written down so the legend can draw the SAME mark at a
 * different size and still be the same mark — a legend of plain dots beside a
 * map of glyphs is a legend that teaches the wrong thing.
 */
export function markGeometry(r: number) {
  return {
    /** Running's dashed motion ring and needs-you's heavy one. */
    ring: n2(r + r / 3),
    /** The hatched disc behind a gated station. */
    gate: n2(r + r * 0.4),
    /** The claim cordon. */
    claim: n2(r + r * 0.53),
    /** The hover / focus / selected emphasis, outermost. */
    halo: n2(r + r * 0.73),
    /** A state or actor chip's radius, and how far its centre sits on the diagonal. */
    chip: n2(r * 0.52),
    offset: n2(r * 0.8),
    /** Half a glyph inside a chip. */
    glyph: n2(r * 0.52 * 0.62),
    /** Where the station's name hangs. */
    label: n2(r + 19),
  };
}

/** The drawn marks. A glyph, never a letter: text at this size is a smudge. */
type MarkGlyph = 'check' | 'play' | 'next' | 'wait' | 'alert' | 'gate';

/**
 * The glyph each UI state wears. Five reach the map (`BOARD_STATE_UI` emits
 * done, running, queued, waiting and needs-you); the other three are given the
 * nearest reading rather than a blank, because a state with no glyph is the
 * one case a reader cannot tell from a rendering bug.
 */
const STATE_GLYPH: Record<UiState, MarkGlyph> = {
  'needs-you': 'alert',
  failed: 'alert',
  running: 'play',
  verifying: 'play',
  waiting: 'wait',
  queued: 'next',
  skipped: 'wait',
  done: 'check',
};

/** The two states whose ring is part of the reading, not decoration. */
const RINGED: ReadonlySet<UiState> = new Set<UiState>(['running', 'needs-you']);

function Glyph({ kind, cx, cy, g }: { kind: MarkGlyph; cx: number; cy: number; g: number }) {
  switch (kind) {
    case 'check':
      return (
        <path
          className="mark-glyph"
          d={`M${n2(cx - g)},${n2(cy + 0.05 * g)} L${n2(cx - 0.25 * g)},${n2(cy + 0.8 * g)} L${n2(cx + g)},${n2(cy - 0.75 * g)}`}
        />
      );
    case 'play':
      return (
        <path
          className="mark-glyph filled"
          d={`M${n2(cx - 0.55 * g)},${n2(cy - 0.95 * g)} L${n2(cx + 0.95 * g)},${n2(cy)} L${n2(cx - 0.55 * g)},${n2(cy + 0.95 * g)} Z`}
        />
      );
    case 'next':
      return (
        <path
          className="mark-glyph"
          d={
            `M${n2(cx - g)},${n2(cy - 0.85 * g)} L${n2(cx - 0.1 * g)},${n2(cy)} L${n2(cx - g)},${n2(cy + 0.85 * g)}` +
            ` M${n2(cx + 0.15 * g)},${n2(cy - 0.85 * g)} L${n2(cx + 1.05 * g)},${n2(cy)} L${n2(cx + 0.15 * g)},${n2(cy + 0.85 * g)}`
          }
        />
      );
    case 'wait':
      // An hourglass drawn in one stroke: top bar, the sand's diagonal, floor.
      return (
        <path
          className="mark-glyph"
          d={`M${n2(cx - 0.8 * g)},${n2(cy - 0.9 * g)} L${n2(cx + 0.8 * g)},${n2(cy - 0.9 * g)} L${n2(cx - 0.8 * g)},${n2(cy + 0.9 * g)} L${n2(cx + 0.8 * g)},${n2(cy + 0.9 * g)}`}
        />
      );
    case 'alert':
      return (
        <>
          <path className="mark-glyph" d={`M${n2(cx)},${n2(cy - g)} L${n2(cx)},${n2(cy + 0.15 * g)}`} />
          <circle className="mark-glyph filled" cx={n2(cx)} cy={n2(cy + 0.72 * g)} r={n2(0.22 * g)} />
        </>
      );
    case 'gate':
      // A boom bar and its post — the barrier the hatched ring is made of.
      return (
        <>
          <path
            className="mark-glyph"
            d={`M${n2(cx - g)},${n2(cy + 0.7 * g)} L${n2(cx + g)},${n2(cy - 0.7 * g)}`}
          />
          <path
            className="mark-glyph"
            d={`M${n2(cx - 0.95 * g)},${n2(cy + 0.25 * g)} L${n2(cx - 0.95 * g)},${n2(cy + g)}`}
          />
        </>
      );
  }
}

/** A glyph on its own disc, so it reads over track, hatch and label alike. */
function MarkChip({
  kind,
  cx,
  cy,
  chip,
  g,
  className,
}: {
  kind: MarkGlyph;
  cx: number;
  cy: number;
  chip: number;
  g: number;
  className?: string;
}) {
  return (
    <g className={cn('mark-chip', className)}>
      <circle className="chip-disc" cx={cx} cy={cy} r={chip} />
      <Glyph kind={kind} cx={cx} cy={cy} g={g} />
    </g>
  );
}

/**
 * The dot, its state ring and its state chip — the whole of what a state says.
 *
 * Rendered by the map at `R` and by the legend at the same `R` scaled down by
 * its viewBox, so the two cannot drift.
 */
export function StationMark({ ui, x, y, r }: { ui: UiState; x: number; y: number; r: number }) {
  const geo = markGeometry(r);
  return (
    <>
      {RINGED.has(ui) && <circle className="state-ring" cx={x} cy={y} r={geo.ring} />}
      <circle className="dot" cx={x} cy={y} r={r} />
      <MarkChip
        kind={STATE_GLYPH[ui]}
        cx={x + geo.offset}
        cy={y - geo.offset}
        chip={geo.chip}
        g={geo.glyph}
      />
    </>
  );
}

/** The driver chip: who is holding the phase, over an observed live fact. */
function ActorChip({ actor, cx, cy, chip }: { actor: PhaseActor; cx: number; cy: number; chip: number }) {
  const Icon = ACTOR_ICON[actor];
  const side = n2(chip * 1.5);
  return (
    <g className="mark-chip actor-chip">
      <circle className="chip-disc" cx={cx} cy={cy} r={chip} />
      <Icon
        x={n2(cx - side / 2)}
        y={n2(cy - side / 2)}
        size={side}
        strokeWidth={1.5}
        absoluteStrokeWidth
        aria-hidden
      />
    </g>
  );
}

/* ------------------------------------------------------------------ *
 * Drawing
 * ------------------------------------------------------------------ */

function StationLabel({ node, drop }: { node: PlacedNode; drop: number }) {
  const lines = useMemo(() => wrapLabel(node.title), [node.title]);
  return (
    <text className="station-label" x={node.x} y={node.y + drop} textAnchor="middle">
      {lines.map((line, i) => (
        <tspan key={i} x={node.x} dy={i === 0 ? 0 : 12}>
          {line}
        </tspan>
      ))}
    </text>
  );
}

/** Two lines of at most ~17 characters, the second elided. Ported verbatim. */
export function wrapLabel(title: string): string[] {
  const words = title.split(/\s+/);
  const lines = [''];
  for (const word of words) {
    const line = lines.at(-1)!;
    if ((line + ' ' + word).trim().length > 17 && lines.length < 2) lines.push(word);
    else lines[lines.length - 1] = (line ? `${line} ` : '') + word;
  }
  if (lines.length === 2 && lines[1].length > 17) lines[1] = `${lines[1].slice(0, 16)}…`;
  return lines;
}

interface Train extends BatchGroup {
  nodes: PlacedNode[];
  path: string;
  head: PlacedNode;
}

/**
 * What is OBSERVED to be working a phase, and who claims it.
 *
 * The map's `RouteNode` payload is the engine's and stays the engine's; this
 * rides beside it, joined by phase number at the call site from the same
 * `PhaseView` fields the tables read.
 */
export interface PhaseDriver {
  live?: PhaseLive;
  lock?: PhaseLock;
}

/* ------------------------------------------------------------------ *
 * What a station says
 * ------------------------------------------------------------------ */

/**
 * Everything a station can say without being opened.
 *
 * The map is the one surface where a phase has no room for columns, so these
 * lines are where the same facts the tables carry — what it waits on, whether
 * anyone holds it, who is driving — have to live instead. ONE list, rendered
 * twice: as the native `<title>` a mouse hovers, and as the fact strip a
 * finger gets, because a `<title>` never appears on a phone.
 */
export function stationFacts(
  node: { phase: number; title: string; size: string; gated?: boolean; locked?: 'live' | 'stale' },
  state: PhaseState,
  needs: number[] | undefined,
  driver?: PhaseDriver,
  critical?: boolean,
): string[] {
  const lines = [`Phase ${node.phase} — ${node.title}`, `${boardLabel(state)} · size ${node.size}`];
  if (needs?.length) lines.push(`needs ${needs.map((p) => `P${p}`).join(' · ')}`);
  if (node.gated) lines.push('gated — a person must clear it before it boards');
  if (critical) lines.push('on the critical path');

  const lock = driver?.lock;
  const held = lock ? `${lock.owner}${lock.host ? ` on ${lock.host}` : ''}` : null;
  const actor = driver?.live?.actor;
  if (actor) lines.push(held ? `${PHASE_ACTOR_LABELS[actor]} · held by ${held}` : PHASE_ACTOR_LABELS[actor]);
  else if (driver?.live) lines.push(held ? `working · held by ${held}` : 'working now');
  else if (lock?.expired) lines.push(`a lapsed claim by ${held} — release it to tidy the board`);
  else if (lock) lines.push(`claimed by ${held}`);
  else if (node.locked === 'live') lines.push('claimed by another session');
  else if (node.locked === 'stale') lines.push('a lapsed claim — release it to tidy the board');
  return lines;
}

const stationTitle = (...args: Parameters<typeof stationFacts>) => stationFacts(...args).join('\n');

/* ------------------------------------------------------------------ *
 * The legend
 * ------------------------------------------------------------------ */

/** The legend draws the mark at the map's own radius and scales it by viewBox. */
const LEGEND_R = 15;
const LEGEND_BOX = 27;

/**
 * The map's own mark at legend size — the thing `ui/legend.tsx` calls `mark`.
 *
 * Named for what it draws rather than for where it is shown: the legend is a
 * shared primitive now, and this is the map's contribution to it.
 */
function MarkSvg({ ui, live, children }: { ui?: UiState; live?: boolean; children: React.ReactNode }) {
  return (
    <svg
      className={cn('legend-mark route-mark', ui && `state-${ui}`, live && 'live')}
      viewBox={`${-LEGEND_BOX} ${-LEGEND_BOX} ${LEGEND_BOX * 2} ${LEGEND_BOX * 2}`}
      width="22"
      height="22"
      aria-hidden
      focusable="false"
    >
      {children}
    </svg>
  );
}

/**
 * The five states a board word reaches, worst first, plus everything else the
 * map draws. `ready` reads "Next up" like every badge in the console.
 */
const LEGEND_STATES: readonly { state: UiState; label: string }[] = [
  { state: 'needs-you', label: STATE_META['needs-you'].label },
  { state: 'running', label: STATE_META.running.label },
  { state: 'queued', label: boardLabel('ready') },
  { state: 'waiting', label: STATE_META.waiting.label },
  { state: 'done', label: STATE_META.done.label },
];

/** The order the driver chips are explained in — the vocabulary's own. */
const LEGEND_ACTORS = Object.keys(PHASE_ACTOR_LABELS) as PhaseActor[];

/**
 * The map's key, built from `ui/legend.tsx` and handing it the map's own marks.
 *
 * This component used to BE the legend — the only one in the console that drew
 * the real glyph rather than a stand-in dot, and the only one whose comment said
 * why. The rule moved into the shared primitive; what stays here is the part
 * that is genuinely the map's: which marks, in which order, and the disclosure
 * that keeps eleven of them out of the way until asked for.
 */
function RouteLegend() {
  const [open, setOpen] = useState(false);
  const geo = markGeometry(LEGEND_R);
  const states = LEGEND_STATES.map(({ state, label }) => ({
    key: state,
    label,
    mark: (
      <MarkSvg ui={state} live={state === 'running'}>
        <StationMark ui={state} x={0} y={0} r={LEGEND_R} />
      </MarkSvg>
    ),
  }));
  const rest = [
    {
      key: 'gated',
      label: 'Gated',
      mark: (
        <MarkSvg ui="needs-you">
          <circle className="gate-ring" cx={0} cy={0} r={geo.gate} fill="url(#gate-hatch)" />
          <circle className="dot" cx={0} cy={0} r={LEGEND_R} />
          <MarkChip kind="gate" cx={-geo.offset} cy={geo.offset} chip={geo.chip} g={geo.glyph} />
        </MarkSvg>
      ),
    },
    {
      key: 'claimed',
      label: 'Claimed',
      mark: (
        <MarkSvg ui="waiting">
          <circle className="claim-ring live" cx={0} cy={0} r={geo.claim} />
          <circle className="dot" cx={0} cy={0} r={LEGEND_R} />
        </MarkSvg>
      ),
    },
    {
      key: 'lapsed',
      label: 'Lapsed claim',
      mark: (
        <MarkSvg ui="waiting">
          <circle className="claim-ring stale" cx={0} cy={0} r={geo.claim} />
          <circle className="dot" cx={0} cy={0} r={LEGEND_R} />
        </MarkSvg>
      ),
    },
    ...LEGEND_ACTORS.map((actor) => ({
      key: `actor-${actor}`,
      label: PHASE_ACTOR_LABELS[actor],
      mark: (
        <MarkSvg ui="running" live>
          <circle className="dot" cx={0} cy={0} r={LEGEND_R} />
          <ActorChip actor={actor} cx={geo.offset} cy={geo.offset} chip={geo.chip} />
        </MarkSvg>
      ),
    })),
    {
      key: 'critical',
      label: 'Critical path',
      mark: <span className="legend-line critical" aria-hidden />,
    },
    {
      key: 'train',
      label: 'Session batch',
      mark: <span className="legend-line train" aria-hidden />,
    },
    // The ruling is `aria-hidden` on the map — forty stray "wave 3, 5" text
    // nodes in the a11y tree teach nobody anything. This is where a column is
    // explained, in words, once. The wording is careful: a wave is a FLOOR on
    // when a phase can start, never a promise that its neighbours run beside
    // it — scope decides that, and the map does not know scopes.
    {
      key: 'wave',
      label: 'Wave — earliest it could start',
      mark: <span className="legend-band" aria-hidden />,
    },
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <Legend entries={states} inline className="gap-x-3 gap-y-1.5 font-display uppercase tracking-wider" />
      <Button
        size="sm"
        variant="ghost"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
        title="The rest of the map's marks — gates, claims, who is driving, session batches."
      >
        {open ? 'Less' : 'Key'}
      </Button>
      {open && (
        <Legend entries={rest} inline className="gap-x-3 gap-y-1.5 font-display uppercase tracking-wider" />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * The map
 * ------------------------------------------------------------------ */

export interface RouteMapProps {
  route: RouteView;
  batches?: SessionPlanView | null;
  /** The plan's per-session budget, in tokens — printed beside each train. */
  budget?: number;
  onSelect?: (phase: number) => void;
  /** A phase's own address, so the fact strip's Open is a real link. */
  hrefFor?: (phase: number) => string;
  /** The station drawn with the emphasis ring — where the map opened. */
  selected?: number | null;
  /**
   * The station the map opens looking at.
   *
   * A plan of forty phases fits the frame by being drawn small, and the one
   * node that wanted a person was as likely to be in a corner as anywhere. The
   * caller decides WHICH — this only knows how to look at it — and it is
   * honoured once per plan, so panning away is not undone on the next render.
   */
  focus?: number | null;
  /** Phases the analysis puts on the longest remaining chain. */
  critical?: ReadonlySet<number> | null;
  /** Who is working each phase right now, and who claims it. */
  drivers?: ReadonlyMap<number, PhaseDriver> | null;
  className?: string;
}

export function RouteMap({
  route,
  batches,
  budget,
  onSelect,
  hrefFor,
  selected,
  focus,
  critical,
  drivers,
  className,
}: RouteMapProps) {
  const { points, width, height } = useMemo(() => positions(route), [route]);
  const geo = useMemo(() => markGeometry(R), []);
  const bands = useMemo(() => platforms(route, width), [route, width]);

  /**
   * The edges, split into the trunk and everything else.
   *
   * SVG has no z-index — paint order is document order — so drawing the
   * critical path INSIDE the one edge pass meant a later ordinary edge painted
   * straight over it. On any plan with fan-out the trunk arrived at a junction
   * and disappeared into it. Two passes, ordinary first, and the trunk (with
   * its casing) last: the line the reader is meant to follow is the one that
   * passes over.
   *
   * `dim` is deliberately NOT computed here. It changes on hover, and folding
   * it in would re-walk every edge and re-derive every path string on every
   * pointer move over the map.
   */
  const drawn = useMemo(() => {
    const plain: DrawnEdge[] = [];
    const trunk: DrawnEdge[] = [];
    for (const edge of route.edges) {
      const from = points.get(edge.from);
      const to = points.get(edge.to);
      if (!from || !to) continue;
      const drawnEdge: DrawnEdge = {
        key: `${edge.from}-${edge.to}`,
        from: edge.from,
        to: edge.to,
        done: boardUiState(asPhaseState(from.state)) === 'done',
        d: trackPath(from, to),
        i: Math.min(from.layer, STAGGER_CAP),
      };
      if (critical?.has(edge.from) && critical.has(edge.to)) trunk.push(drawnEdge);
      else plain.push(drawnEdge);
    }
    return { plain, trunk };
  }, [route.edges, points, critical]);

  const [hover, setHover] = useState<number | null>(null);
  /** The station a finger asked about — there is no hover to ask with. */
  const [peek, setPeek] = useState<number | null>(null);
  const [prefs, setPrefs] = usePrefs();
  const narrow = useNarrow();
  const touch = useTouch();
  const fitKey = `${route.nodes.length}:${width}:${height}`;
  const focusPoint = useMemo(() => {
    const point = focus == null ? undefined : points.get(focus);
    return point ? { x: point.x, y: point.y } : null;
  }, [focus, points]);
  const { frame, view, size, fit, zoomCentre, dragged, handlers } = useMapView({
    width,
    contentH: height,
    fitKey,
    focusPoint,
    interactive: prefs.mapPanZoom,
  });

  // A new plan is a new map: whatever a finger was asking about is gone.
  useEffect(() => setPeek(null), [fitKey]);

  /** What each station waits on — the edges, read the way a tooltip needs them. */
  const incoming = useMemo(() => {
    const map = new Map<number, number[]>();
    for (const edge of route.edges) {
      const list = map.get(edge.to);
      if (list) list.push(edge.from);
      else map.set(edge.to, [edge.from]);
    }
    return map;
  }, [route]);

  /* Hover is the desktop's question and `peek` the phone's; both dim the rest
     of the network down to the station's own neighbours. `selected` does NOT —
     it is where the map opened, and a map that dimmed nine tenths of itself the
     moment it opened would be answering a question nobody asked. */
  const highlight = hover ?? peek ?? null;
  const ringed = peek ?? selected ?? null;
  const related = useMemo(() => {
    if (highlight == null) return null;
    const set = new Set<number>([highlight]);
    for (const edge of route.edges) {
      if (edge.to === highlight) set.add(edge.from);
      if (edge.from === highlight) set.add(edge.to);
    }
    return set;
  }, [highlight, route]);

  /**
   * A train is drawn as a dashed line threading the stations it carries, not
   * as a box around them — a bounding box would enclose bystanders that are
   * not in the batch at all, which is exactly the wrong thing to imply.
   */
  const trains = useMemo<Train[]>(
    () =>
      (batches?.groups ?? [])
        .map((group) => {
          const nodes = group.phases
            .map((phase) => points.get(phase))
            .filter((n): n is PlacedNode => Boolean(n));
          if (!nodes.length) return null;
          const ordered = [...nodes].sort((a, b) => a.layer - b.layer || a.row - b.row);
          return {
            ...group,
            nodes: ordered,
            path: ordered.map((node, i) => `${i === 0 ? 'M' : 'L'}${node.x},${node.y}`).join(' '),
            head: ordered[0],
          };
        })
        .filter((t): t is Train => Boolean(t)),
    [batches, points],
  );

  /* The window, in plan units. Falls back to the content box until the frame
     has been measured, so the first paint draws the whole map rather than a
     division by zero. */
  const boxW = (size.w || width * view.k) / view.k;
  const boxH = (size.h || height * view.k) / view.k;

  /* A station's hit area, in plan units, so it lands at 44 CSS px whatever the
     zoom. Capped at the row pitch: a target that overlaps its neighbour is
     worse than a small one, and below MIN_K the cap would be doing that. */
  const hitR = Math.min(TAP / view.k, ROW_H - 6) / 2;

  const peekNode = peek == null ? null : points.get(peek);
  const peekFacts = peekNode
    ? stationFacts(
        peekNode,
        asPhaseState(peekNode.state),
        incoming.get(peekNode.phase),
        drivers?.get(peekNode.phase),
        critical?.has(peekNode.phase),
      )
    : null;

  /* A tap is a question on touch and an answer on a mouse. The first tap on a
     phone opens the fact strip (there is no hover to read a `<title>` with);
     the second tap on the SAME station, and Enter anywhere, opens the phase. */
  const choose = (phase: number) => {
    if (dragged.current) return;
    if (touch && peek !== phase) {
      setPeek(phase);
      return;
    }
    onSelect?.(phase);
  };

  return (
    <div className={cn('overflow-hidden rounded-lg border border-rule bg-surface', className)}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-rule bg-surface-raised px-3 py-2">
        <RouteLegend />
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            aria-pressed={prefs.mapPanZoom}
            aria-label="Pan and zoom"
            title={
              prefs.mapPanZoom
                ? 'Lock the map — the page scrolls over it again.'
                : 'Unlock to pan, drag and pinch the map. The − / + / Fit buttons always work.'
            }
            onClick={() => setPrefs({ mapPanZoom: !prefs.mapPanZoom })}
          >
            {prefs.mapPanZoom ? <Unlock size={13} aria-hidden /> : <Lock size={13} aria-hidden />}
            {!narrow && <span className="ml-1">Pan &amp; zoom</span>}
          </Button>
          <span className="font-mono text-2xs text-ink-faint" aria-live="off">
            {Math.round(view.k * 100)}%
          </span>
          <ButtonGroup>
            <Button size="sm" onClick={() => zoomCentre(1 / ZOOM_STEP)} aria-label="Zoom out">
              −
            </Button>
            <Button size="sm" onClick={() => zoomCentre(ZOOM_STEP)} aria-label="Zoom in">
              +
            </Button>
            <Button size="sm" onClick={fit} title="Fit the whole plan — double-click the map does the same.">
              Fit
            </Button>
          </ButtonGroup>
        </div>
      </div>

      {peekNode && peekFacts && (
        <div
          className="flex flex-wrap items-start gap-2 border-b border-rule px-3 py-2"
          role="group"
          aria-label={`Phase ${peekNode.phase} facts`}
        >
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-ink">{peekFacts[0]}</div>
            <ul className="mt-0.5 flex flex-col gap-0.5 text-2xs text-ink-muted">
              {peekFacts.slice(1).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
          <div className="flex items-center gap-1">
            {hrefFor ? (
              <Button asChild size="sm" variant="action">
                <a href={hrefFor(peekNode.phase)}>Open phase</a>
              </Button>
            ) : (
              <Button size="sm" variant="action" onClick={() => onSelect?.(peekNode.phase)}>
                Open phase
              </Button>
            )}
            <Button size="sm" variant="ghost" aria-label="Close facts" onClick={() => setPeek(null)}>
              <X size={13} aria-hidden />
            </Button>
          </div>
        </div>
      )}

      <div
        className="route-frame"
        ref={frame}
        data-interactive={prefs.mapPanZoom || undefined}
        onDoubleClick={(event) => {
          if ((event.target as Element).closest?.('.station')) return;
          fit();
        }}
        {...handlers}
      >
        <svg
          className="route-svg"
          width="100%"
          height="100%"
          viewBox={`${n2(view.x)} ${n2(view.y)} ${n2(boxW)} ${n2(boxH)}`}
          preserveAspectRatio="xMidYMid meet"
          /* `group`, not `img`. It held forty `role="button"` children, which
             is a contradiction: an image has no interactive content, so a
             screen reader was told to ignore every station on the map. */
          role="group"
          aria-label={`Phase dependency map — ${route.nodes.length} stations`}
        >
          <defs>
            <pattern
              id="gate-hatch"
              width="6"
              height="6"
              patternTransform="rotate(45)"
              patternUnits="userSpaceOnUse"
            >
              <line x1="0" y1="0" x2="0" y2="6" stroke="var(--line-gated)" strokeWidth="3" opacity="0.5" />
            </pattern>
            {/* Marker contents inherit from the `<defs>`, never from the path
                that references them, so a marker cannot read the track's own
                `--state`: the critical path gets its own. `userSpaceOnUse`
                keeps the head one size whatever the stroke does. */}
            <marker
              id="track-arrow"
              markerUnits="userSpaceOnUse"
              markerWidth="8"
              markerHeight="7"
              refX="7.5"
              refY="3.5"
              orient="auto"
            >
              <path d="M0,0 L8,3.5 L0,7 Z" fill="var(--track)" />
            </marker>
            <marker
              id="track-arrow-critical"
              markerUnits="userSpaceOnUse"
              markerWidth="9"
              markerHeight="8"
              refX="8.5"
              refY="4"
              orient="auto"
            >
              <path d="M0,0 L9,4 L0,8 Z" fill="var(--action)" />
            </marker>
          </defs>

          {/* The board, ruled — under everything and deaf to the pointer.
              A hairline and a heading per wave, and no fill: this drew
              alternating bands for one QA round, which is a table's device
              rather than a map's and which broke the trunk's casing (a casing
              is the PAPER's colour, and a paper that alternates cannot have
              one). The ruling spans the frame, so one that took a pointer would
              take every pointer meant for a station. Skipped on a one-wave
              plan: ruling a single column compares it with nothing.
              `aria-hidden` because the wave is structure, not a record — the
              legend below teaches what a column means, in words, once. */}
          {bands.length > 1 && (
            <g className="platforms" aria-hidden="true">
              {bands.map((band) => (
                <g key={band.layer}>
                  {band.layer > 0 && (
                    <line
                      className="platform-rule"
                      x1={n2(band.left)}
                      y1={0}
                      x2={n2(band.left)}
                      y2={n2(height)}
                    />
                  )}
                  <text
                    className="platform-label"
                    x={n2((band.left + band.right) / 2)}
                    y={18}
                    textAnchor="middle"
                  >
                    wave {band.layer + 1}
                  </text>
                  <text
                    className="platform-count"
                    x={n2((band.left + band.right) / 2)}
                    y={31}
                    textAnchor="middle"
                  >
                    {band.count}
                  </text>
                </g>
              ))}
            </g>
          )}

          <g>
            {trains.map((train) => (
              <g className="train" key={`train-${train.index}`}>
                {train.nodes.length > 1 && <path className="train-line" d={train.path} />}
                {/* Outside every ring the station itself wears, or the batch's
                    cordon reads as one more thing the phase is in. */}
                {train.nodes.map((node) => (
                  <circle key={node.phase} className="train-ring" cx={node.x} cy={node.y} r={geo.halo + 3} />
                ))}
                <text
                  x={train.head.x}
                  y={train.head.y - geo.halo - 6}
                  className="band-label"
                  textAnchor="middle"
                >
                  S{train.index} · {train.weight ?? ''}
                  {budget ? `/${weight(budget)}` : ''}
                  {train.gated ? ' · gated' : ''}
                </text>
              </g>
            ))}

            {drawn.plain.map((edge) => (
              <path
                key={edge.key}
                className={cn(
                  'track',
                  // `state-done` rather than a second name for the done hue:
                  // the class is what puts `--state` on the path, and the
                  // stroke below is the only thing that reads it.
                  edge.done && 'track-done state-done',
                  dimEdge(related, edge) && 'dim',
                )}
                /* `pathLength` normalises the geometry to 100 units, which is
                   what lets one `stroke-dasharray` draw every edge in exactly
                   — the hard-coded 1400 drew a short edge as a dotted line
                   and a long one not at all. */
                pathLength={100}
                style={{ '--i': edge.i } as React.CSSProperties}
                d={edge.d}
              />
            ))}

            {/* The trunk, last, so it passes OVER every line it crosses.
                Casings first inside the group for the same reason — see
                `.track-casing` in route-map.css for why a transit line needs
                one at all. Nothing here is a second copy of an edge above:
                `drawn` partitions, it does not duplicate, so the map still
                draws exactly one `.track` per edge. */}
            {drawn.trunk.length > 0 && (
              <g className="trunk">
                {drawn.trunk.map((edge) => (
                  <path
                    key={`casing-${edge.key}`}
                    className={cn('track-casing', dimEdge(related, edge) && 'dim')}
                    aria-hidden="true"
                    pathLength={100}
                    style={{ '--i': edge.i } as React.CSSProperties}
                    d={edge.d}
                  />
                ))}
                {drawn.trunk.map((edge) => (
                  <path
                    key={edge.key}
                    className={cn(
                      'track',
                      'track-critical',
                      edge.done && 'track-done state-done',
                      dimEdge(related, edge) && 'dim',
                    )}
                    pathLength={100}
                    style={{ '--i': edge.i } as React.CSSProperties}
                    d={edge.d}
                  />
                ))}
              </g>
            )}

            {/* Each station carries an invisible `station-hit` circle sized in
                plan units to land at 44 CSS px. The 15-unit dot it sits under
                is a 13px circle at the fit zoom of a phone — a mark, not a
                target. Transparent rather than `fill: none`, because `none`
                does not receive pointer events at all. */}
            {[...points.values()].map((node) => {
              const dim = related && !related.has(node.phase);
              const state = asPhaseState(node.state);
              const ui = boardUiState(state);
              const driver = drivers?.get(node.phase);
              const live = Boolean(driver?.live);
              const actor = driver?.live?.actor;
              // A claim is somebody standing on the platform; a live fact is a
              // process. Draw the cordon only when there is no process to draw.
              const claim = live
                ? null
                : driver?.lock
                  ? driver.lock.expired
                    ? 'stale'
                    : 'live'
                  : node.locked;
              return (
                <g
                  key={node.phase}
                  className={cn(
                    'station route-mark',
                    // The station wears its UI state; the CSS paints by it.
                    `state-${ui}`,
                    live && 'live',
                    dim && 'dim',
                    ringed === node.phase && 'selected',
                  )}
                  tabIndex={0}
                  role="button"
                  aria-label={`Phase ${node.phase}: ${node.title}, ${boardLabel(state)}`}
                  onClick={() => choose(node.phase)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onSelect?.(node.phase);
                    }
                  }}
                  onMouseEnter={() => setHover(node.phase)}
                  onMouseLeave={() => setHover(null)}
                  /* Focus has to light the same neighbours hover does, or the
                     keyboard walks the map with the one affordance the mouse
                     gets for free switched off. */
                  onFocus={() => setHover(node.phase)}
                  onBlur={() => setHover(null)}
                >
                  <circle className="station-hit" cx={node.x} cy={node.y} r={hitR} />
                  {node.gated && (
                    <circle
                      className="gate-ring"
                      cx={node.x}
                      cy={node.y}
                      r={geo.gate}
                      fill="url(#gate-hatch)"
                    />
                  )}
                  {claim && (
                    <circle className={cn('claim-ring', claim)} cx={node.x} cy={node.y} r={geo.claim} />
                  )}
                  <circle className="halo" cx={node.x} cy={node.y} r={geo.halo} />
                  <StationMark ui={ui} x={node.x} y={node.y} r={R} />
                  <text className="station-number" x={node.x} y={node.y + 4} textAnchor="middle">
                    {node.phase}
                  </text>
                  {node.gated && (
                    <MarkChip
                      kind="gate"
                      cx={node.x - geo.offset}
                      cy={node.y + geo.offset}
                      chip={geo.chip}
                      g={geo.glyph}
                      className="gate-chip"
                    />
                  )}
                  {actor && (
                    <ActorChip
                      actor={actor}
                      cx={node.x + geo.offset}
                      cy={node.y + geo.offset}
                      chip={geo.chip}
                    />
                  )}
                  <StationLabel node={node} drop={geo.label} />
                  <title>
                    {stationTitle(node, state, incoming.get(node.phase), driver, critical?.has(node.phase))}
                  </title>
                </g>
              );
            })}
          </g>
        </svg>
      </div>
    </div>
  );
}
