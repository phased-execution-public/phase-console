/**
 * Logs ▸ Health over time (measured-console phase 31, §Architecture 9 F2) — a bounded time series
 * per measure, where Health used to draw only the present.
 *
 * Four measures, each a point `{ at, v }` in `<instance state>/health-series.ndjson` (0600):
 *
 *   **gate** — the full gate's seconds per run of `scripts/gates.sh`, read from its marker JSON
 *     (`<git common dir>/phase-console-gates-ok.json`: `total_s`, `ended_at`, `head`); one point
 *     per marker, deduplicated by its end.
 *   **load** — the machine's load as the scheduler reads it (`service-base.ts` `loadSample`): the
 *     five-minute average over the cores, sampled every `HEALTH_SAMPLE_MS`.
 *   **persist** — the mean milliseconds a run save took over the sample's window (`runner/state.ts`
 *     `takePersistTiming`); a window with no save writes nothing, not a zero.
 *   **reconcile** — the reconciliation's delta against the provider's bill, % (Pro: read from
 *     `reconciliation.ndjson` when the series is read, never copied into this file).
 *
 * Bounded twice: at most `HEALTH_SERIES_MAX_POINTS` per measure, and nothing older than the
 * retention policy's `healthSeriesDays` (`HEALTH_SERIES_DAYS` by default) — the file is
 * rewritten without the excess when the sampler prunes it (once a day, and when the file grows
 * past its bound). Pure readers below; one small class owns the file.
 */

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const HEALTH_MEASURES = Object.freeze(['gate', 'load', 'persist', 'reconcile'] as const);
export type HealthMeasure = (typeof HEALTH_MEASURES)[number];

/** The sampler's cadence for `load` and `persist`. */
export const HEALTH_SAMPLE_MS = 5 * 60_000;
/** The most points one measure keeps: a week of five-minute samples, and some. */
export const HEALTH_SERIES_MAX_POINTS = 2_100;
/** The default retention, days. */
export const HEALTH_SERIES_DAYS = 30;
export const HEALTH_SERIES_FILE = 'health-series.ndjson';

export type HealthPoint = { m: HealthMeasure; at: string; v: number; note?: string };

export type HealthSeriesView = {
  from: string;
  to: string;
  bounds: { maxPoints: number; days: number; sampleMs: number };
  measures: Record<HealthMeasure, { at: string; v: number; note?: string }[]>;
};

const isMeasure = (value: unknown): value is HealthMeasure => HEALTH_MEASURES.includes(value as HealthMeasure);

export function pointOf(raw: unknown): HealthPoint | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!isMeasure(r.m) || typeof r.at !== 'string' || !Number.isFinite(Date.parse(r.at))) return null;
  if (typeof r.v !== 'number' || !Number.isFinite(r.v)) return null;
  return { m: r.m, at: new Date(Date.parse(r.at)).toISOString(), v: r.v, ...(typeof r.note === 'string' && r.note ? { note: r.note.slice(0, 80) } : {}) };
}

/** The points kept: inside the retention, and the newest `maxPoints` of each measure — oldest first. */
export function boundPoints(points: readonly HealthPoint[], now: number, days: number, maxPoints: number): HealthPoint[] {
  const since = now - days * 86_400_000;
  const kept: HealthPoint[] = [];
  for (const measure of HEALTH_MEASURES) {
    const own = points.filter((p) => p.m === measure && Date.parse(p.at) >= since).sort((a, b) => a.at.localeCompare(b.at));
    kept.push(...own.slice(-maxPoints));
  }
  return kept.sort((a, b) => a.at.localeCompare(b.at));
}

/** The full gate's marker JSON as one point — `total_s` at its `ended_at` — or null for anything else. */
export function gateMarkerPoint(raw: unknown): HealthPoint | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const seconds = typeof r.total_s === 'number' ? r.total_s : Number(r.total_s);
  const at = typeof r.ended_at === 'string' ? r.ended_at : typeof r.ended_at === 'number' ? new Date(r.ended_at * 1000).toISOString() : null;
  if (!Number.isFinite(seconds) || seconds < 0 || !at || !Number.isFinite(Date.parse(at))) return null;
  return pointOf({ m: 'gate', at, v: seconds, note: typeof r.head === 'string' ? r.head.slice(0, 12) : undefined });
}

/** The series as a page reads it: each measure's points in the window, oldest first, plus extra points read elsewhere. */
export function seriesView(
  points: readonly HealthPoint[],
  opts: { now: number; days: number; maxPoints?: number; extra?: readonly HealthPoint[] },
): HealthSeriesView {
  const maxPoints = opts.maxPoints ?? HEALTH_SERIES_MAX_POINTS;
  const kept = boundPoints([...points, ...(opts.extra ?? [])], opts.now, opts.days, maxPoints);
  const measures = Object.fromEntries(HEALTH_MEASURES.map((m) => [m, [] as { at: string; v: number; note?: string }[]])) as HealthSeriesView['measures'];
  for (const p of kept) measures[p.m].push({ at: p.at, v: p.v, ...(p.note ? { note: p.note } : {}) });
  return {
    from: new Date(opts.now - opts.days * 86_400_000).toISOString(),
    to: new Date(opts.now).toISOString(),
    bounds: { maxPoints, days: opts.days, sampleMs: HEALTH_SAMPLE_MS },
    measures,
  };
}

/** The file's owner: append, read, prune. Every write is best-effort — Health never costs the console. */
export class HealthSeries {
  readonly file: string;
  private readonly now: () => number;
  private readonly maxPoints: number;

  constructor(opts: { dir: string; now?: () => number; maxPoints?: number }) {
    this.file = join(opts.dir, HEALTH_SERIES_FILE);
    this.now = opts.now ?? Date.now;
    this.maxPoints = opts.maxPoints ?? HEALTH_SERIES_MAX_POINTS;
  }

  points(): HealthPoint[] {
    if (!existsSync(this.file)) return [];
    const out: HealthPoint[] = [];
    for (const line of readFileSync(this.file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const point = pointOf(JSON.parse(line));
        if (point) out.push(point);
      } catch {
        /* a torn line is skipped */
      }
    }
    return out;
  }

  /** One point; a gate point already held (same end) is not written twice. */
  record(measure: HealthMeasure, value: number, opts: { at?: string; note?: string } = {}): boolean {
    const point = pointOf({ m: measure, at: opts.at ?? new Date(this.now()).toISOString(), v: value, note: opts.note });
    if (!point) return false;
    if (measure === 'gate' && this.points().some((p) => p.m === 'gate' && p.at === point.at)) return false;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      appendFileSync(this.file, `${JSON.stringify(point)}\n`, { mode: 0o600 });
      return true;
    } catch {
      return false;
    }
  }

  /** Rewrite the file within its bounds; returns how many points left. */
  prune(days: number = HEALTH_SERIES_DAYS): number {
    const all = this.points();
    const kept = boundPoints(all, this.now(), days, this.maxPoints);
    if (kept.length === all.length) return 0;
    try {
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, kept.map((p) => JSON.stringify(p)).join('\n') + (kept.length ? '\n' : ''), { mode: 0o600 });
      renameSync(tmp, this.file);
      chmodSync(this.file, 0o600);
    } catch {
      return 0;
    }
    return all.length - kept.length;
  }

  view(days: number = HEALTH_SERIES_DAYS, extra: readonly HealthPoint[] = []): HealthSeriesView {
    return seriesView(this.points(), { now: this.now(), days, maxPoints: this.maxPoints, extra });
  }
}
