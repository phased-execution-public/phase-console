/**
 * The Phases view's `map` reading: the plan drawn as a network (`dag.tsx`),
 * joined to what the route payload does not carry — where the map opens, the
 * critical path, who is driving each phase and what the run is verifying —
 * and, since one-pool phase 16 (#376), the map's tools: filters, a trace, a
 * hover card, colour, layers, layouts and export, every one of them in the
 * address (`./tools`).
 *
 * The page reaches this module through `lazy()`, so the map, its stylesheet
 * and its maths ride a chunk of their own and a plan opened on its table never
 * downloads them.
 */

import { memo, useCallback, useMemo, useRef } from 'react';
import type { PlanDetail, RunState } from '@/data/api';
import { isLive } from '@/data/lanes';
import { countdown, duration, money } from '@/lib/format';
import { navigate, phaseHref, planViewHref } from '@/shell/routes';
import { toast } from '@/ui';
import { describeWord } from '@shared/status-model.js';
import { PHASE_ACTOR_LABELS } from '@shared/status-vocab.js';
import { mergeBoard, type PhaseTableRow, type PhaseTableScope } from '../phases/model';
import { inspectPhase } from '../phases/inspector';
import { RouteMap, type PhaseDriver } from './dag';
import { downloadPng, downloadSvg } from './export';
import type { HoverFacts } from './hover-card';
import {
  MapToolbar,
  chipsOf,
  colorScale,
  mapToolsOf,
  mapToolsSearch,
  passes,
  reposOf,
  traceOf,
  traceWords,
  type MapTools,
  type StationFacts,
} from './tools';

/**
 * The map, drawn only when what it draws has changed.
 *
 * Memoised HERE rather than at its definition because this is the caller that
 * can hold its props still: `route`, `batches` and `budget` come from a query
 * with structural sharing, and `focus`, `onSelect` and `hrefFor` are
 * stabilised in `MapView` below. A `memo` around a component whose caller mints
 * a new `onSelect` every render costs a comparison and saves nothing.
 */
const MemoRouteMap = memo(RouteMap);

/**
 * The station the map should open looking at.
 *
 * A handoff that reads blocked first, then whatever is moving, then the first
 * thing that COULD move — the order of urgency, because a map of forty phases
 * is drawn small enough that the one node worth seeing is as likely to be in a
 * corner as anywhere.
 *
 * `null` on a plan where nothing wants anything: a map that always snapped
 * somewhere would teach the operator that the snap means nothing.
 */
export function focusPhase(detail: Pick<PlanDetail, 'phases'>): number | null {
  const by = (...states: string[]) => detail.phases.find((p) => states.includes(p.state))?.phase ?? null;
  return by('stuck') ?? by('in-progress') ?? by('ready');
}

/**
 * The phases a run is verifying right now — its records reading `verifying`
 * and not yet ended. The board has no such word, so the map learns it here.
 */
export function verifyingPhases(run: Pick<RunState, 'phases'> | null | undefined): Set<number> {
  const set = new Set<number>();
  for (const record of Object.values(run?.phases ?? {})) {
    if (record.status === 'verifying' && !record.endedAt) set.add(record.phase);
  }
  return set;
}

/**
 * Each station's facts as the tools read them: its board word, size, gate,
 * place on the critical path, repositories, and what it has spent and taken —
 * the plan's cost record first, the run's own record where the plan has none.
 */
export function stationFactsOf(
  detail: Pick<PlanDetail, 'phases' | 'cost'>,
  run?: Pick<RunState, 'phases'> | null,
): StationFacts[] {
  const costs = new Map((detail.cost?.phases ?? []).map((c) => [c.phase, c]));
  return detail.phases.map((p) => {
    const record = run?.phases?.[String(p.phase)];
    const cost = costs.get(p.phase);
    const usd = cost?.usd ?? record?.costUsd;
    const ms = cost?.durationMs ?? record?.durationMs;
    return {
      phase: p.phase,
      state: p.state,
      size: p.size ?? '',
      gated: Boolean(p.gated),
      critical: Boolean(p.analysis?.onCriticalPath),
      repos: reposOf(p.row?.repos),
      ...(typeof usd === 'number' ? { costUsd: usd } : {}),
      ...(typeof ms === 'number' ? { durationMs: ms } : {}),
    };
  });
}

/** One station's hover card, in words — every fact the page holds about the phase. */
export function hoverFactsOf(
  detail: Pick<PlanDetail, 'phases' | 'cost' | 'eta' | 'route'>,
  run: Pick<RunState, 'phases'> | null | undefined,
  phase: number,
): HoverFacts | null {
  const p = detail.phases.find((one) => one.phase === phase);
  if (!p) return null;
  const record = run?.phases?.[String(phase)];
  const cost = detail.cost?.phases.find((c) => c.phase === phase);
  const eta = p.state === 'done' ? undefined : detail.eta?.perPhase.find((e) => e.phase === phase);
  const usd = cost?.usd ?? record?.costUsd;
  const actor = p.live?.actor;
  const session = p.live?.session ?? record?.sessionId;
  const model = record?.actualModel ?? record?.model;
  const driver = [
    actor ? PHASE_ACTOR_LABELS[actor] : p.live ? 'Working now' : '',
    session ? `session ${session.slice(0, 8)}` : '',
    model ? `model ${model}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const lock = p.lock
    ? p.lock.expired
      ? `A lapsed claim by ${p.lock.owner}`
      : `Claimed by ${p.lock.owner}${p.lock.leaseUntil ? `, lease ${countdown(p.lock.leaseUntil)}` : ''}`
    : undefined;
  return {
    phase,
    title: p.title,
    state:
      record?.status === 'verifying' && !record.endedAt ? 'Verifying' : describeWord('board', p.state).label,
    size: p.size,
    ...(eta ? { estimate: duration(eta.estMs) } : {}),
    ...(typeof usd === 'number' && usd > 0 ? { cost: `${money(usd)} so far` } : {}),
    ...((record?.attempts ?? cost?.attempts) ? { attempts: record?.attempts ?? cost?.attempts } : {}),
    ...(driver ? { driver } : {}),
    ...(lock ? { lock } : {}),
    ...(p.gated ? { gate: `Gated${p.gateKind && p.gateKind !== 'none' ? `: ${p.gateKind}` : ''}` } : {}),
    ...(p.handoff ? { handoff: `Handoff ${p.handoff.status}` } : {}),
    trace: traceWords(traceOf(detail.route.edges, phase)),
  };
}

export function MapView({
  detail,
  run,
  query = {},
  allowRun = false,
}: {
  detail: PlanDetail;
  run?: RunState | Pick<RunState, 'phases'> | null;
  /** The page's address query — where the tools live. */
  query?: Readonly<Record<string, string | undefined>>;
  allowRun?: boolean;
}) {
  const slug = detail.summary.slug;
  const focus = useMemo(() => focusPhase(detail), [detail]);
  const verifying = useMemo(() => verifyingPhases(run), [run]);
  const tools = useMemo(() => mapToolsOf(query), [query]);

  /*
   * The two things the map draws that the ROUTE payload does not carry.
   *
   * `RouteView` is the engine's own projection and stays it — fields added
   * there would put analysis and process facts inside the topology. Both are
   * already on `detail.phases` for the table, so they are joined by phase
   * number here, memoised on the phase list so the live stream does not mint a
   * new Map on every tick.
   */
  const critical = useMemo(() => {
    const set = new Set<number>();
    for (const phase of detail.phases) if (phase.analysis?.onCriticalPath) set.add(phase.phase);
    return set.size ? set : null;
  }, [detail.phases]);

  const drivers = useMemo(() => {
    const map = new Map<number, PhaseDriver>();
    for (const phase of detail.phases) {
      const checking = verifying.has(phase.phase);
      if (phase.live || phase.lock || checking) {
        map.set(phase.phase, {
          live: phase.live,
          lock: phase.lock,
          ...(checking ? { verifying: true } : {}),
        });
      }
    }
    return map.size ? map : null;
  }, [detail.phases, verifying]);

  /* ---- the tools ---- */
  const stations = useMemo(() => stationFactsOf(detail, run), [detail, run]);
  const chips = useMemo(() => chipsOf(stations), [stations]);
  const scale = useMemo(() => colorScale(tools.color, stations), [tools.color, stations]);
  const byPhase = useMemo(() => new Map(stations.map((s) => [s.phase, s])), [stations]);
  const dimmed = useMemo(() => {
    const set = new Set(stations.filter((s) => !passes(s, tools)).map((s) => s.phase));
    return set.size ? set : null;
  }, [stations, tools]);
  const paintOf = useCallback(
    (phase: number) => {
      const station = byPhase.get(phase);
      return station ? scale.paintOf(station) : undefined;
    },
    [byPhase, scale],
  );
  const repoOf = useCallback((phase: number) => byPhase.get(phase)?.repos[0], [byPhase]);
  const traceText = useMemo(
    () => (tools.sel != null ? traceWords(traceOf(detail.route.edges, tools.sel)) : null),
    [tools.sel, detail.route.edges],
  );

  /** Every tool writes the address, and the address is the only state there is. */
  const setTools = useCallback(
    (next: MapTools) => {
      const extra = mapToolsSearch(next);
      navigate(planViewHref(slug, 'map', extra), { replace: true });
    },
    [slug],
  );

  /* ---- the doors ---- */
  const scope = useMemo<PhaseTableScope>(
    () => ({
      slug,
      run: run && 'status' in run ? run : null,
      live: Boolean(run && 'status' in run && isLive(run.status ?? '')),
      allowRun,
      onRunAlone: (phase: number) => navigate(phaseHref(slug, phase)),
    }),
    [slug, run, allowRun],
  );
  const rows = useMemo(
    () => mergeBoard(detail.phases, run && 'status' in run ? run : null),
    [detail.phases, run],
  );
  const onInspect = useCallback(
    (phase: number) => {
      const p = rows.find((row) => row.phase === phase);
      if (p) {
        const row: PhaseTableRow = {
          p,
          scope,
          eta: detail.eta?.perPhase.find((e) => e.phase === phase),
          rulings: 0,
          holds: detail.qaHeld?.[phase] ?? p.qaHeld ?? [],
        };
        inspectPhase(row);
      }
      setTools({ ...tools, sel: phase });
    },
    [rows, scope, detail.eta, detail.qaHeld, tools, setTools],
  );
  const onTrace = useCallback((phase: number) => setTools({ ...tools, sel: phase }), [tools, setTools]);
  const cardFor = useCallback((phase: number) => hoverFactsOf(detail, run, phase), [detail, run]);
  const onSelect = useCallback((phase: number) => navigate(phaseHref(slug, phase)), [slug]);
  const hrefFor = useCallback((phase: number) => phaseHref(slug, phase), [slug]);

  const drawing = useRef<SVGSVGElement | null>(null);
  const onExport = useCallback(
    (kind: 'svg' | 'png') => {
      const svg = drawing.current;
      if (!svg) return;
      if (kind === 'svg') downloadSvg(svg, slug);
      else
        void downloadPng(svg, slug).then((url) => {
          if (!url) toast('The browser could not draw the map as a PNG; the SVG still exports.', 'error');
        });
    },
    [slug],
  );

  const toolbar = useMemo(
    () => (
      <MapToolbar
        tools={tools}
        chips={chips}
        colorKey={scale.key}
        trace={traceText}
        onChange={setTools}
        onExport={onExport}
      />
    ),
    [tools, chips, scale.key, traceText, setTools, onExport],
  );

  return (
    <MemoRouteMap
      route={detail.route}
      batches={detail.batches}
      budget={detail.summary.budget}
      focus={focus}
      /* The station the map opened on keeps a ring: a map that centred
         somewhere and then said nothing about why has moved for no reason the
         reader can see. Ring only — `focus` never dims the network. */
      selected={focus}
      critical={critical}
      drivers={drivers}
      onSelect={onSelect}
      hrefFor={hrefFor}
      layout={tools.layout}
      layers={tools.layers}
      repoOf={repoOf}
      paintOf={paintOf}
      dimmed={dimmed}
      trace={tools.sel}
      onInspect={onInspect}
      cardFor={cardFor}
      onTrace={onTrace}
      exportRef={drawing}
      tools={toolbar}
    />
  );
}
