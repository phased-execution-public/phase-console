/**
 * The plan's burn-up (one-pool phase 16, #376) — phases done, and weight done,
 * over time, against the plan's whole, with the forecast's band from now to
 * its earliest and latest finish.
 *
 * ```
 * 100% ┤······················· scope ···········╱▔▔▔▔▔▔
 *      │                              ┊      ╱  ╱  ETA band
 *  50% ┤          ┌─────┘▔▔▔▔▔▔▔▔▔▔▔▔▔┊ ╱  ╱
 *      │   ┌──────┘  phases done      ┊╱ ╱
 *   0% ┼───┘───────────────────────── now ─────────────
 *      Oct 12        Oct 14        Oct 17       Oct 19
 * ```
 *
 * Both series are a share of the plan's whole — the phases, and the phases'
 * weights — so one axis reads both and a plan whose heavy phases are left
 * says so by the gap between them. A phase done with no record of when counts
 * from the axis's first moment, and the figure says how many did. The
 * arithmetic is `burnupOf`, pure; the paint is state tokens only (`done`,
 * `running`, `waiting`), never a literal colour.
 */

import { useId, useMemo, useRef } from 'react';

import { cn } from '@/lib/cn';
import { plural } from '@/lib/format';

import { FigureNumbers } from './numbers';
import { FIGURE_TYPE, textWidth, useWidth } from './paint';
import { linear } from './scales';
import { stampOf } from './schedule';

export interface BurnupPhase {
  phase: number;
  weight: number;
  state: string;
  /** When it was done: the run record's end, else the cost record's, else its handoff's date. */
  doneAt?: number | undefined;
}

export interface BurnupInput {
  phases: readonly BurnupPhase[];
  /** The plan's calendar forecast (`PlanDetail.forecast`), when it has a date. */
  forecast?: {
    earliest?: string | undefined;
    expected?: string | undefined;
    latest?: string | undefined;
  } | null;
  now: number;
}

export interface BurnupPoint {
  at: number;
  phases: number;
  weight: number;
  /** The phase that moved the line here, or none for the axis's first point. */
  phase?: number;
}

export interface Burnup {
  points: BurnupPoint[];
  totalPhases: number;
  totalWeight: number;
  t0: number;
  t1: number;
  /** Done with no record of when — counted from `t0`. */
  undated: number;
  band?: { earliest: number; expected?: number; latest: number };
}

const at = (iso: string | undefined): number | undefined => {
  const ms = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(ms) ? ms : undefined;
};

/** The burn-up, as arithmetic. */
export function burnupOf(input: BurnupInput): Burnup {
  const { now } = input;
  const done = input.phases.filter((p) => p.state === 'done');
  const dated = done.filter((p) => typeof p.doneAt === 'number').sort((a, b) => a.doneAt! - b.doneAt!);
  const undated = done.length - dated.length;
  const totalPhases = input.phases.length;
  const totalWeight = input.phases.reduce((sum, p) => sum + Math.max(0, p.weight), 0);
  const first = dated[0]?.doneAt ?? now;
  // A day before the first finish, so the first step is drawn rather than standing on the axis.
  const t0 = Math.min(first - 86_400_000, now - 3_600_000);
  const undatedWeight = done.filter((p) => typeof p.doneAt !== 'number').reduce((s, p) => s + p.weight, 0);
  const points: BurnupPoint[] = [{ at: t0, phases: undated, weight: undatedWeight }];
  let phases = undated;
  let weight = undatedWeight;
  for (const p of dated) {
    phases += 1;
    weight += Math.max(0, p.weight);
    points.push({ at: p.doneAt!, phases, weight, phase: p.phase });
  }
  const earliest = at(input.forecast?.earliest);
  const latest = at(input.forecast?.latest);
  const expected = at(input.forecast?.expected);
  const left = done.length < totalPhases;
  const band =
    left && earliest !== undefined && latest !== undefined
      ? {
          earliest: Math.max(now, earliest),
          latest: Math.max(now, latest),
          ...(expected !== undefined ? { expected: Math.max(now, expected) } : {}),
        }
      : undefined;
  const t1 = Math.max(now, band?.latest ?? now) + 3_600_000;
  return { points, totalPhases, totalWeight, t0, t1, undated, ...(band ? { band } : {}) };
}

const HEIGHT = 200;
const LEFT = 44;
const RIGHT = 12;
const TOP = 14;
const BOTTOM = 22;
const DAY = 86_400_000;

export function BurnupFigure({ input, className }: { input: BurnupInput; className?: string }) {
  const heading = useId();
  const box = useRef<HTMLDivElement>(null);
  const width = useWidth(box, 1000);
  const burnup = useMemo(() => burnupOf(input), [input]);
  const { points, totalPhases, totalWeight, t0, t1, band, undated } = burnup;
  const withDay = t1 - t0 > DAY / 2;
  const words = (ms: number) => stampOf(ms, withDay);
  const x = linear([t0, t1], [LEFT, Math.max(LEFT + 1, width - RIGHT)]);
  const y = (share: number) => TOP + (1 - share) * (HEIGHT - TOP - BOTTOM);
  const share = (n: number, of: number) => (of > 0 ? n / of : 0);
  const now = input.now;
  const last = points.at(-1)!;

  /** A step line through the points, held level to now. */
  const steps = (value: (p: BurnupPoint) => number) => {
    const parts = [`M${x(points[0]!.at)},${y(value(points[0]!))}`];
    for (const p of points.slice(1)) parts.push(`H${x(p.at)}`, `V${y(value(p))}`);
    parts.push(`H${x(now)}`);
    return parts.join(' ');
  };
  const phaseShare = (p: BurnupPoint) => share(p.phases, totalPhases);
  const weightShare = (p: BurnupPoint) => share(p.weight, totalWeight);

  // The date labels: as many as fit, each a whole label apart.
  const ticks: number[] = [];
  const pitch = textWidth(words(t1)) + 2 * FIGURE_TYPE;
  const count = Math.max(2, Math.min(6, Math.floor((width - LEFT - RIGHT) / pitch)));
  for (let i = 0; i < count; i++) ticks.push(t0 + ((t1 - t0) * i) / (count - 1));

  const summary =
    `${last.phases} of ${plural(totalPhases, 'phase')} done (${Math.round(phaseShare(last) * 100)}%), ` +
    `${Math.round(weightShare(last) * 100)}% of the weight` +
    (band ? `; the forecast finishes between ${words(band.earliest)} and ${words(band.latest)}` : '');

  return (
    <section
      data-testid="plan-burnup"
      aria-labelledby={heading}
      className={cn('flex min-w-0 flex-col gap-2', className)}
    >
      <h3 id={heading} className="text-section text-ink">
        Burn-up
      </h3>
      <p className="text-meta text-ink-muted tnum" data-testid="burnup-summary">
        {summary}.
        {undated
          ? ` ${plural(undated, 'phase')} done with no record of when count from the first day drawn.`
          : ''}
      </p>
      <div ref={box} className="min-w-0">
        <svg
          width={width}
          height={HEIGHT}
          role="img"
          aria-label={`Burn-up: ${summary}`}
          data-figure="burnup"
          className="block"
        >
          {[0, 0.5, 1].map((s) => (
            <g key={s}>
              <line x1={LEFT} x2={width - RIGHT} y1={y(s)} y2={y(s)} stroke="var(--rule)" />
              <text
                x={LEFT - 6}
                y={y(s) + FIGURE_TYPE * 0.35}
                textAnchor="end"
                fontSize={FIGURE_TYPE}
                fill="var(--ink-faint)"
              >
                {Math.round(s * 100)}%
              </text>
            </g>
          ))}
          {ticks.map((t, i) => (
            <text
              key={t}
              data-tick=""
              x={x(t)}
              y={HEIGHT - 6}
              textAnchor={i === 0 ? 'start' : i === ticks.length - 1 ? 'end' : 'middle'}
              fontSize={FIGURE_TYPE}
              fill="var(--ink-faint)"
            >
              {words(t)}
            </text>
          ))}
          {band && (
            <path
              className="state-waiting"
              data-testid="burnup-band"
              d={`M${x(now)},${y(phaseShare(last))} L${x(band.earliest)},${y(1)} L${x(band.latest)},${y(1)} Z`}
              fill="var(--state)"
              fillOpacity={0.18}
              stroke="none"
            >
              <title>{`The forecast: done between ${words(band.earliest)} and ${words(band.latest)}`}</title>
            </path>
          )}
          {band?.expected !== undefined && (
            <line
              className="state-waiting"
              x1={x(now)}
              y1={y(phaseShare(last))}
              x2={x(band.expected)}
              y2={y(1)}
              stroke="var(--state)"
              strokeDasharray="4 3"
            />
          )}
          <path
            className="state-running"
            data-testid="burnup-weight"
            d={steps(weightShare)}
            fill="none"
            stroke="var(--state)"
            strokeWidth={1.5}
            strokeDasharray="5 3"
          />
          <path
            className="state-done"
            data-testid="burnup-phases"
            d={steps(phaseShare)}
            fill="none"
            stroke="var(--state)"
            strokeWidth={2}
          />
          <line
            x1={x(now)}
            x2={x(now)}
            y1={TOP - 4}
            y2={HEIGHT - BOTTOM}
            stroke="var(--ink-muted)"
            strokeDasharray="2 3"
          />
        </svg>
      </div>
      <ul
        data-slot="legend"
        aria-label="Key"
        className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-meta text-ink-muted"
      >
        <li className="flex items-center gap-1.5">
          <i aria-hidden className="state-done h-0.5 w-4 shrink-0 bg-state" />
          Phases done
        </li>
        <li className="flex items-center gap-1.5">
          <i aria-hidden className="state-running h-0.5 w-4 shrink-0 bg-state" />
          Weight done
        </li>
        {band && (
          <li className="flex items-center gap-1.5">
            <i aria-hidden className="state-waiting h-2 w-4 shrink-0 bg-state opacity-30" />
            Forecast band, earliest to latest
          </li>
        )}
        <li className="flex items-center gap-1.5">Dotted line: now</li>
      </ul>
      <FigureNumbers
        label="points"
        caption="Each finish: when it was done, and the phases and the weight done by then"
        rows={points}
        getRowKey={(point, i) => `${point.at}-${i}`}
        columns={[
          { head: 'When', cell: (point) => (point.phase ? words(point.at) : 'Before the record') },
          { head: 'Phase', cell: (point) => (point.phase ? `P${point.phase}` : '—') },
          { head: 'Phases done', cell: (point) => `${point.phases} of ${totalPhases}`, align: 'end' },
          {
            head: 'Weight done',
            cell: (point) => `${Math.round(share(point.weight, totalWeight) * 100)}%`,
            align: 'end',
          },
        ]}
      />
    </section>
  );
}

export default BurnupFigure;
