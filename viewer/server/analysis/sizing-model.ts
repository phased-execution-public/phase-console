/**
 * The sizing model (control-tower phase 59, #83, AUD-25): what one session
 * costs in CONTEXT, and how many sessions a phase takes under the console.
 *
 * `scripts/sizing.env` used to say a session's real context ran about three
 * times its summed phase weight — a pure multiple, which implies a session
 * that does nothing costs nothing. Measured over the audit week it was never
 * true: the FIRST call of a fresh phase session already read ~120k on hub and
 * ~82k on pe-hub, peaks were nearly flat across the tags (median S 325k,
 * M 419k, L 481k — 21.6×, 10.5× and 5.3× the weight), and 107 of 108 phases
 * exceeded the model's own 3× line. An affine fit through the medians put the
 * intercept near 313k and the slope near 2: the slope was close to the model,
 * the intercept was missing.
 *
 * So a session is sized here as `boot + work + slope × weight`:
 *
 *   - **boot** — the first call's context (`phase.tokens` `firstContext`),
 *     measured per repository: the system prompt, the tool listing, CLAUDE.md,
 *     the rules, the memory index and the boot prompt. It is reported as its
 *     own line (`bootFloorLine`), because it is the part a repository can
 *     shrink, and a smaller one lowers every session it ever runs;
 *   - **work** — what every phase session adds above its boot whatever its
 *     size: the plan and handoff reads, verification, the closeout;
 *   - **slope × weight** — what the phase's own size adds.
 *
 * `boot + work` is the per-session FLOOR, paid once by every session — which
 * is also why the autopilot's unit matters: it boards `1 phase ≥ 1 session`
 * and never batches (SIZ-3), so the forecast here counts sessions from what
 * phases measurably took (`sessionsPerPhaseOf`), split by size and by whether
 * the phase wrapped its context, never from a weight budget.
 *
 * The fit is phase 58's affine model (`fitAffine`, shared with the ETA's
 * `fitShape`) with every tag weighing once, since the claim this model makes
 * is per tag. The shipped values in `scripts/sizing.env` are this module's own
 * fit over `test/fixtures/sizing/sessions-corpus.json`, and
 * `test/sizing-model.test.ts` holds the two together.
 *
 * Pure: sessions in, numbers out. The service feeds it its own stored runs;
 * `phase-graph.sh --session-plan` prints the same arithmetic from the shipped
 * values (`test/sizing-env.test.ts` holds the twins together).
 */

import type { PhaseSize } from '../parse/plan.ts';
import { deriveCapTable, type CapSample, type CapTable } from '../runner/session-record.ts';
import { expectedFromEnv, sessionsFor, type Sizing } from './graph.ts';
import { ETA_CLASS_MIN, fitAffine, median } from './stats.ts';

/** One measured session as the model reads it: a `phase.tokens` line joined to its phase's size. */
export type SizingSession = {
  mode?: string;
  resumed?: boolean;
  size?: PhaseSize | null;
  /** The phase's weight; absent means the size's shipped weight. */
  weight?: number | null;
  calls?: number;
  peakContext?: number;
  /** The first call's context — the boot, for a fresh session. Absent on lines before phase 59. */
  firstContext?: number;
  at?: string;
};

/** The shipped half of the model — `scripts/sizing.env`, read by `analysis/graph.ts` `loadSizing`. */
export type ShippedSizing = Pick<Sizing, 'S' | 'M' | 'L' | 'bootFloor' | 'workFloor' | 'slopePct' | 'targetPct' | 'sessions'>;

const SIZES: readonly PhaseSize[] = ['S', 'M', 'L'];

const weightOfSession = (s: SizingSession, shipped: Pick<ShippedSizing, 'S' | 'M' | 'L'>): number =>
  typeof s.weight === 'number' && s.weight > 0 ? s.weight : s.size ? shipped[s.size] : shipped.M;

/**
 * `121144` → `121K`, `5775000` → `5,775K`, a whole million → `1M`: the
 * resolution every line of this model is read at. `_kilo` in `phase-graph.sh`
 * is the twin.
 */
export function tokensK(tokens: number): string {
  const k = Math.round(tokens / 1000);
  if (k >= 1000 && k % 1000 === 0) return `${k / 1000}M`;
  return `${String(k).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}K`;
}

/* ------------------------------------------------------------------ *
 * The boot floor
 * ------------------------------------------------------------------ */

/** How many measured boots a repository needs before its floor is a reading rather than the shipped default. */
export const BOOT_FLOOR_MIN_SAMPLES = 3;

/** A repository's boot floor: the median first-call context of its fresh phase sessions, with its evidence. */
export type BootFloor = { tokens: number; samples: number; min: number; max: number; from: string | null; to: string | null };

/** A fresh phase session with a recorded first call: a boot. A resume's first call re-reads a conversation. */
function isBoot(s: SizingSession): boolean {
  return (s.mode ?? 'phase') === 'phase' && s.resumed !== true && typeof s.firstContext === 'number' && s.firstContext > 0;
}

/**
 * The boot floor of the sessions given — the caller decides which repository
 * they belong to. Only a phase session's own boot counts: a repair's or a
 * closeout's brief is a different prompt (hub's repairs booted at 70–80k while
 * its phases booted at 121k). Null below `BOOT_FLOOR_MIN_SAMPLES`: unmeasured,
 * never a guess.
 */
export function bootFloorOf(sessions: readonly SizingSession[]): BootFloor | null {
  const boots = sessions.filter(isBoot).sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''));
  if (boots.length < BOOT_FLOOR_MIN_SAMPLES) return null;
  const values = boots.map((s) => s.firstContext!);
  return {
    tokens: Math.round(median(values)),
    samples: boots.length,
    min: Math.min(...values),
    max: Math.max(...values),
    from: boots[0]!.at ?? null,
    to: boots[boots.length - 1]!.at ?? null,
  };
}

/** One boot floor per repository (a console's `instance`), for a reader that holds several. */
export function bootFloorsByInstance(sessions: readonly (SizingSession & { instance: string })[]): Map<string, BootFloor> {
  const groups = new Map<string, SizingSession[]>();
  for (const s of sessions) groups.set(s.instance, [...(groups.get(s.instance) ?? []), s]);
  const out = new Map<string, BootFloor>();
  for (const [instance, list] of groups) {
    const floor = bootFloorOf(list);
    if (floor) out.set(instance, floor);
  }
  return out;
}

/** The boot floor as its own line — what `--session-plan` and the plan page print. */
export function bootFloorLine(floor: BootFloor | null, shipped = 0): string {
  if (!floor) {
    return `Boot floor: ${tokensK(shipped)} per session — shipped default; this repository has fewer than ${BOOT_FLOOR_MIN_SAMPLES} measured sessions`;
  }
  return `Boot floor: ${tokensK(floor.tokens)} per session — the first call's context on this repository, measured over ${floor.samples} sessions (${tokensK(floor.min)}–${tokensK(floor.max)})`;
}

/* ------------------------------------------------------------------ *
 * The context model: boot + work + slope × weight
 * ------------------------------------------------------------------ */

/**
 * The fewest API calls a session must have made to measure a phase's context.
 * A session that stopped before twenty calls ended before its work did — a
 * crash, a refused start, an immediate limit — and its peak is its boot. The
 * audit's own filter.
 */
export const CONTEXT_MIN_CALLS = 20;

/**
 * The newest fresh phase sessions the model is fitted on — bounded, like the
 * ETA's pool, because a repository's prefix grows and shrinks. About two weeks
 * of a busy console; the whole shipped corpus (264) fits inside it.
 */
export const CONTEXT_POOL_WINDOW = 300;

export type ContextModel = {
  /** `measured` — fitted on this console's sessions; `shipped` — `sizing.env`, measured at release. */
  basis: 'measured' | 'shipped';
  /** The boot floor the model adds, and whether this repository measured it. */
  boot: number;
  bootMeasured: BootFloor | null;
  /** What every phase session adds above its boot, whatever its size. */
  work: number;
  /** `boot + work`: paid once by every session. */
  floor: number;
  /** Context per token of weight. */
  slope: number;
  /** Fresh phase sessions the fit weighed. */
  samples: number;
  /** Per size: the median peak, and that median ÷ the model at the size's weight — near 1 is the claim. */
  sizes: { size: string; weight: number; medianPeak: number; samples: number; ratio: number }[];
};

/** A session's predicted peak context under a model. */
export function contextOf(model: Pick<ContextModel, 'floor' | 'slope'>, weight: number): number {
  return model.floor + model.slope * Math.max(0, weight);
}

/** The shipped model, as `sizing.env` states it — the answer when nothing here is measured. */
export function shippedContextModel(shipped: ShippedSizing): ContextModel {
  return {
    basis: 'shipped',
    boot: shipped.bootFloor,
    bootMeasured: null,
    work: shipped.workFloor,
    floor: shipped.bootFloor + shipped.workFloor,
    slope: shipped.slopePct / 100,
    samples: 0,
    sizes: [],
  };
}

function isContextSample(s: SizingSession): boolean {
  return (s.mode ?? 'phase') === 'phase' && s.resumed !== true
    && (s.calls ?? 0) >= CONTEXT_MIN_CALLS && typeof s.peakContext === 'number' && s.peakContext > 0;
}

/**
 * Fit `floor + slope × weight` on measured peaks, and split the floor into the
 * repository's boot and the work above it (SM-1, SM-2).
 *
 * The line goes through the per-size median peaks with every tag weighing once
 * (`fitAffine`, `weighting: 'class'`), because the model's claim is that the
 * measured peak ÷ the model sits near 1 for EVERY tag. The boot is the
 * repository's measured floor, else the shipped one, and `work` is what is
 * left of the fitted floor above it. Fewer than `ETA_CLASS_MIN` usable sessions
 * is the shipped model — with this repository's own boot when it has measured
 * one, since that is the half a repository can know from its first sessions.
 */
export function fitContextModel(sessions: readonly SizingSession[], shipped: ShippedSizing): ContextModel {
  const bootMeasured = bootFloorOf(sessions);
  const boot = bootMeasured?.tokens ?? shipped.bootFloor;
  const window = sessions
    .filter(isContextSample)
    .sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''))
    .slice(-CONTEXT_POOL_WINDOW);
  if (window.length < ETA_CLASS_MIN) return { ...shippedContextModel(shipped), boot, bootMeasured, floor: boot + shipped.workFloor };
  const sizeOf = (s: SizingSession): string => s.size ?? 'M';
  const fit = fitAffine(
    window.map((s) => ({ weight: weightOfSession(s, shipped), value: s.peakContext!, size: sizeOf(s) })),
    { weighting: 'class', proportions: { floor: shipped.bootFloor + shipped.workFloor, slope: shipped.slopePct / 100 } },
  )!;
  const model = { floor: fit.floor, slope: fit.slope };
  const sizes = fit.sizes.map((row) => ({
    size: row.size, weight: row.weight, medianPeak: row.median, samples: row.samples,
    ratio: row.median / contextOf(model, row.weight),
  }));
  return {
    basis: 'measured', boot, bootMeasured, work: Math.max(0, fit.floor - boot), floor: fit.floor, slope: fit.slope,
    samples: window.length, sizes,
  };
}

/**
 * The context line — what a session of a given weight is sized to peak at,
 * and the target it is sized under (`targetPct` of the window).
 */
export function contextLine(model: Pick<ContextModel, 'boot' | 'work' | 'floor' | 'slope'>, window: number, targetPct: number): string {
  const target = (window * targetPct) / 100;
  return `Context: a session peaks near ${tokensK(model.floor)} + ${model.slope.toFixed(2)} × its weight (boot ${tokensK(model.boot)} + work ${tokensK(model.work)}), sized to stay under ${tokensK(target)} — ${targetPct} % of a ${tokensK(window)} window`;
}

/** The weight line, generated — what a plan quotes instead of typing a sum. `--session-plan` prints the same. */
export function weightLine(all: readonly { size?: PhaseSize | null; weight: number }[], left: readonly { size?: PhaseSize | null; weight: number }[]): string {
  const tally = (list: typeof all) => {
    const n = { S: 0, M: 0, L: 0 };
    for (const p of list) n[p.size ?? 'M'] += 1;
    return `${n.L} L · ${n.M} M · ${n.S} S = ${tokensK(list.reduce((a, p) => a + p.weight, 0))}`;
  };
  return `Weight: ${tally(all)} over ${all.length} phases; left: ${tally(left)} over ${left.length}   (generated — quote it, never type a sum)`;
}

/* ------------------------------------------------------------------ *
 * Sessions per phase, and the forecast in sessions
 * ------------------------------------------------------------------ */

/** The unit the console's autopilot runs in (SIZ-3): it boards every phase in a session of its own, and never batches. */
export const FORECAST_UNIT = '1 phase ≥ 1 session';

/** A finished phase, as the session count reads it: how many sessions worked it, and whether it wrapped its context. */
export type PhaseSessions = { size?: PhaseSize | null; sessions: number; wrapped?: boolean; at?: string };

/** How many finished phases of a size stand before its own count replaces the shipped row. */
export const SESSIONS_MIN_PHASES = 5;

/**
 * A phase that took more sessions than this counts as this many: one ten-
 * session phase among thirteen S phases doubled the S mean on its own. The
 * measured p95 was 4.25.
 */
export const SESSIONS_WINSOR = 5;

/** The newest finished phases the count is read over. */
export const SESSIONS_POOL_WINDOW = 200;

/** One size's sessions per phase. `expected` = (1 − wrapRate) × noWrap + wrapRate × wraps. */
export type SessionsRow = {
  noWrap: number;
  wraps: number;
  wrapRate: number;
  expected: number;
  phases: number;
  basis: 'measured' | 'shipped';
};

function shippedRow(row: ShippedSizing['sessions'][PhaseSize]): SessionsRow {
  const wrapRate = row.wrapPct / 100;
  const noWrap = row.noWrapX100 / 100;
  const wraps = row.wrapX100 / 100;
  // The engine's integer arithmetic, so the two agree to the session (sizing-env.test.ts).
  return { noWrap, wraps, wrapRate, expected: expectedFromEnv(row), phases: 0, basis: 'shipped' };
}

const mean = (list: number[]): number => list.reduce((a, b) => a + b, 0) / list.length;

/**
 * Sessions per phase by size, split by whether the phase wrapped (SM-3's
 * forecast half). Each count is winsorised at `SESSIONS_WINSOR`; a size with
 * fewer than `SESSIONS_MIN_PHASES` finished phases is the shipped row, and a
 * size that never wrapped (or never failed to) keeps the shipped figure for the
 * half it has not seen.
 */
export function sessionsPerPhaseOf(phases: readonly PhaseSessions[], shipped: ShippedSizing): Record<PhaseSize, SessionsRow> {
  const window = [...phases]
    .filter((p) => p.sessions > 0)
    .sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''))
    .slice(-SESSIONS_POOL_WINDOW);
  const out = {} as Record<PhaseSize, SessionsRow>;
  for (const size of SIZES) {
    const list = window.filter((p) => (p.size ?? 'M') === size);
    const base = shippedRow(shipped.sessions[size]);
    if (list.length < SESSIONS_MIN_PHASES) {
      out[size] = base;
      continue;
    }
    const count = (p: PhaseSessions) => Math.min(p.sessions, SESSIONS_WINSOR);
    const wrapped = list.filter((p) => p.wrapped);
    const clean = list.filter((p) => !p.wrapped);
    const noWrap = clean.length ? mean(clean.map(count)) : base.noWrap;
    const wraps = wrapped.length ? mean(wrapped.map(count)) : base.wraps;
    const wrapRate = wrapped.length / list.length;
    out[size] = { noWrap, wraps, wrapRate, expected: (1 - wrapRate) * noWrap + wrapRate * wraps, phases: list.length, basis: 'measured' };
  }
  return out;
}

export type SessionForecast = {
  unit: typeof FORECAST_UNIT;
  phases: number;
  /** The expected sessions, rounded — never fewer than one per phase. */
  sessions: number;
  bySize: Record<PhaseSize, { phases: number; sessions: number }>;
};

/**
 * The forecast in sessions (SM-3): every remaining phase's expected sessions
 * for its size, summed. Never fewer than the phases themselves — that is the
 * unit.
 */
export function forecastSessions(
  remaining: readonly { size?: PhaseSize | null }[], table: Record<PhaseSize, SessionsRow>,
): SessionForecast {
  const bySize = { S: { phases: 0, sessions: 0 }, M: { phases: 0, sessions: 0 }, L: { phases: 0, sessions: 0 } } as SessionForecast['bySize'];
  for (const phase of remaining) {
    const size: PhaseSize = phase.size ?? 'M';
    bySize[size].phases += 1;
    bySize[size].sessions += Math.max(1, table[size].expected);
  }
  return { unit: FORECAST_UNIT, phases: remaining.length, sessions: sessionsFor(remaining.map((p) => p.size ?? 'M'), table), bySize };
}

/** `1.46` → `1.5`: sessions per phase are read at one decimal, rounded half up as the engine does. */
const perPhase = (n: number): string => (Math.round(Math.round(n * 100) / 10) / 10).toFixed(1);

/** The forecast as the engine prints it — the count, then where the count came from. */
export function forecastLine(forecast: SessionForecast, table: Record<PhaseSize, SessionsRow>): string {
  const pct = (s: PhaseSize) => Math.round(table[s].wrapRate * 100);
  return `Forecast: ≈ ${forecast.sessions} sessions for ${forecast.phases} phases — sessions per phase, measured: `
    + `S ${perPhase(table.S.noWrap)} (${perPhase(table.S.wraps)} when it wraps, ${pct('S')} % do) · `
    + `M ${perPhase(table.M.noWrap)} (${perPhase(table.M.wraps)}, ${pct('M')} %) · `
    + `L ${perPhase(table.L.noWrap)} (${perPhase(table.L.wraps)}, ${pct('L')} %)`;
}

/* ------------------------------------------------------------------ *
 * The census: a console's own sessions, read into the model
 * ------------------------------------------------------------------ */

/** One journal line as the census reads it — only `phase.session`, `phase.tokens` and `phase.context-wrapup` matter. */
export type CensusLine = { event: string; phase?: number; time?: string; data?: Record<string, unknown> };

/** One stored run: its plan, its phase records' statuses, and its journal's lines. */
export type CensusRun = {
  slug: string;
  phases: Record<string, { phase?: number; status?: string } | undefined>;
  lines: readonly CensusLine[];
};

/** What this console measured about its own sessions — the caps, the context model, sessions per phase. */
export type SizingCensus = {
  caps: CapTable;
  context: ContextModel;
  sessions: Record<PhaseSize, SessionsRow>;
  derivedAt: string;
};

const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

/**
 * Read a console's stored runs into the model (SM-4's input, and SM-1..3's):
 * every `phase.session` line is a cap sample — its largest prompt, where it
 * carries one, since a turn cap binds per prompt; every `phase.tokens` line of a
 * phase whose size the plan states is a context sample; and every finished
 * phase counts its sessions — across runs, since a phase re-boarded under a
 * second run spent both — and whether any of them wrapped its context (a
 * `phase.context-wrapup` at either stage). `sizeOf`
 * answers a phase's size and weight from its plan; a phase it cannot place is
 * left out of the context fit rather than guessed.
 */
export function sizingCensus(
  runs: readonly CensusRun[],
  sizeOf: (slug: string, phase: number) => { size: PhaseSize; weight: number } | undefined,
  shipped: ShippedSizing,
  nowMs: number,
): SizingCensus {
  const capLines: CapSample[] = [];
  const contextSamples: SizingSession[] = [];
  const phases = new Map<string, { size?: PhaseSize; sessions: number; wrapped: boolean; done: boolean; at?: string }>();
  for (const run of runs) {
    for (const line of run.lines) {
      if (typeof line.phase !== 'number') continue;
      const data = line.data ?? {};
      const key = `${run.slug}\u0000${line.phase}`;
      const placed = sizeOf(run.slug, line.phase);
      if (line.event === 'phase.session') {
        capLines.push({
          mode: typeof data.mode === 'string' ? data.mode : undefined, at: line.time,
          // The session's largest PROMPT beside its sum (control-tower phase 89,
          // #62's SIZ-7): `--max-turns` binds per prompt, so the caps are
          // calibrated on the first, and a line from before it has the sum alone.
          turns: num(data.turns), promptTurns: num(data.promptTurns), costUsd: num(data.costUsd), bookedUsd: num(data.bookedUsd),
          costSource: typeof data.costSource === 'string' ? data.costSource : undefined, resumed: data.resumed === true,
        });
        const entry = phases.get(key) ?? { size: placed?.size, sessions: 0, wrapped: false, done: false };
        entry.sessions += 1;
        entry.at = line.time;
        phases.set(key, entry);
      } else if (line.event === 'phase.tokens' && placed) {
        contextSamples.push({
          mode: typeof data.mode === 'string' ? data.mode : undefined, resumed: data.resumed === true,
          size: placed.size, weight: placed.weight, calls: num(data.calls), peakContext: num(data.peakContext),
          firstContext: num(data.firstContext), at: line.time,
        });
      } else if (line.event === 'phase.context-wrapup') {
        // The 0.6 steer or the 0.8 checkpoint (its `stage`): either way the phase wrapped.
        const entry = phases.get(key) ?? { size: placed?.size, sessions: 0, wrapped: false, done: false };
        entry.wrapped = true;
        phases.set(key, entry);
      }
    }
    for (const record of Object.values(run.phases)) {
      if (record?.status !== 'done' || typeof record.phase !== 'number') continue;
      const entry = phases.get(`${run.slug}\u0000${record.phase}`);
      if (entry) entry.done = true;
    }
  }
  const finished: PhaseSessions[] = [...phases.values()]
    .filter((p) => p.done && p.sessions > 0 && p.size)
    .map((p) => ({ size: p.size, sessions: p.sessions, wrapped: p.wrapped, at: p.at }));
  return {
    caps: deriveCapTable(capLines, nowMs),
    context: fitContextModel(contextSamples, shipped),
    sessions: sessionsPerPhaseOf(finished, shipped),
    derivedAt: new Date(nowMs).toISOString(),
  };
}
