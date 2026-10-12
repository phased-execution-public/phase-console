/**
 * Insights' words — what the ETA, cost, velocity, session-sizing and
 * week-report panels print, made from the server's own figures (quiet-console
 * phases 19 and 26).
 *
 * The rule this module holds: those panels print the SERVER's arithmetic,
 * never their own. Every number below is a field the server sent, formatted —
 * never two of them combined into a third. A sum, a difference or a rate
 * times a weight made in the browser would be a second arithmetic beside the
 * one every other surface reads (a phase's ETA, a run's spend, the cap a rung
 * is refused against), free to round, bucket or model differently. So the
 * server carries the sums: `/api/spend`'s `total`, each day's `usd` and
 * `today.ladderLeftUsd`; `/api/stats`' `totals.open` and `rate.mediumMs`;
 * `/api/sizing`'s context floor beside its boot and work; every share and
 * hour `/api/report` measured. A server older than 7.0 that did not send one
 * gets "—" here, never a figure made up in its place (`model.test.ts`).
 */

import type { EtaBasis, EtaEstimate, PlanSummaryFull, Portfolio, SpendView } from '@/data/api';
import type { SessionCap, SessionSizing, WeekMetrics } from '@/data/runs';
import { duration, money, plural, weight } from '@/lib/format';
import { overDayCap } from '@shared/ladder-model.js';

/** A fact as a panel prints it: its label, its value, and a few words on what the value is. */
export interface InsightFact {
  label: string;
  value: string;
  hint?: string;
}

/** What a panel prints where the server did not say. */
export const NOT_SAID = '—';

/* ---------------- how long is left ---------------- */

/** What a basis claims, in a sentence: the same "about N" means three different things. */
export function basisWords(basis: EtaBasis, scoped: boolean): string {
  if (basis === 'plan') return 'This plan’s own: measured from its completed phases.';
  if (basis === 'portfolio') {
    return scoped
      ? 'Pooled across every plan: this one has not finished enough phases to speak for itself.'
      : 'Pooled across every plan’s measured phases.';
  }
  return 'The shipped constants: nothing has finished yet, so this is a placeholder, not a forecast.';
}

/**
 * How many finished phases the reading weighted — and, when some taught it
 * nothing (a closeout-only finish, a duration nobody recorded), how many were
 * left out. The evidence is never silently smaller than what finished.
 */
export function samplesWords(samples: number, missing: number): string {
  const leftOut = missing ? `, ${missing} left out with no usable measurement` : '';
  return `${plural(samples, 'measured phase')} weighted${leftOut}`;
}

/**
 * The band, said as the factor it is. `spread` runs the same factor above the
 * point and below it (point ÷ (1 + spread) … point × (1 + spread)), so a `±`
 * percent would misstate the lower end; and it is read from how the measured
 * phases fell around the model, never from how many there were.
 */
export function bandWords(spread: number): string {
  const factor = (1 + spread).toFixed(1);
  return `÷${factor} to ×${factor} of the estimate, where three in four measured phases fell`;
}

/** The affine model the server draws every ETA from: a floor, and a slope per unit of weight. */
export function etaModelWords(floorMs: number, slopeMsPerWeight: number): string {
  return `${duration(floorMs)} plus ${Math.round(slopeMsPerWeight)} ms per unit of weight`;
}

/** The median gap between one phase landing and the next, in words; null when the server has none. */
export function medianGapWords(days: number | undefined): string | null {
  if (days == null) return null;
  if (days === 0) return 'the same day';
  return `${days} ${days === 1 ? 'day' : 'days'}`;
}

export interface EtaReading {
  /** The answer, in one sentence. */
  answer: string;
  /** The standing counts beside it. (The median gap is How fast's.) */
  facts: InsightFact[];
  /** The estimate and what it stands on; null when there is no measured reading to show. */
  estimate: InsightFact[] | null;
  /** The model under the estimate — a fact Everything shows. */
  model: InsightFact | null;
  /**
   * The floor under one plan's estimate, as the two counts the server sent:
   * how many sessions must run in order, of how many are left. Never their
   * difference — the reader is given both.
   */
  floor: { minimum: number; remaining: number; all: boolean } | null;
}

export function etaReading(
  stats: Portfolio,
  scope: { plan?: string; planEta?: EtaEstimate | null; planStats?: PlanSummaryFull } = {},
): EtaReading {
  const t = stats.totals;

  if (scope.plan) {
    const eta = scope.planEta ?? null;
    const own = scope.planStats;
    const minimum = own?.minimumSessions;
    const remaining = own?.remainingSessions;
    return {
      // The server's label already says what it is ("~2h–4h of work left").
      answer: eta
        ? `${eta.label} in ${scope.plan}: ${plural(eta.remainingPhases, 'phase')}, ${weight(eta.remainingWeight)} of weight.`
        : `No estimate for ${scope.plan}.`,
      facts: [
        ...(typeof remaining === 'number'
          ? [{ label: 'Sessions left', value: String(remaining), hint: 'one phase is at least one session' }]
          : []),
        ...(own ? [{ label: 'Ready now', value: String(own.ready.length) }] : []),
        ...(own ? [{ label: 'In flight', value: String(own.inProgress.length) }] : []),
      ],
      estimate: eta
        ? [
            {
              label: 'Estimate',
              value: eta.label,
              hint: 'working time: nothing parked, queued or overnight',
            },
            {
              label: 'Phases left',
              value: `${plural(eta.remainingPhases, 'phase')}, ${weight(eta.remainingWeight)}`,
            },
            { label: 'Basis', value: basisWords(eta.basis, true) },
            { label: 'Samples', value: samplesWords(eta.samples, eta.missing) },
          ]
        : null,
      model: eta ? { label: 'Model', value: etaModelWords(eta.floorMs, eta.slopeMsPerWeight) } : null,
      floor:
        typeof minimum === 'number' && typeof remaining === 'number' && minimum >= 1
          ? { minimum, remaining, all: minimum >= remaining }
          : null,
    };
  }

  const rate = stats.rate;
  const measured = rate && rate.basis !== 'heuristic' ? rate : null;
  const across = typeof t.open === 'number' ? ` across ${plural(t.open, 'open plan')}` : '';
  return {
    answer: t.remainingSessions
      ? `${plural(t.remainingSessions, 'session')} left, ${weight(t.remainingWeight)} of work${across}.`
      : `Nothing is left to do${across}.`,
    facts: [
      { label: 'Ready now', value: String(t.ready) },
      { label: 'In flight', value: String(t.inProgress) },
    ],
    estimate: measured
      ? [
          {
            label: 'An M phase',
            value: measured.mediumMs == null ? NOT_SAID : `about ${duration(measured.mediumMs)} of work`,
          },
          { label: 'Basis', value: basisWords(measured.basis, false) },
          { label: 'Samples', value: samplesWords(measured.samples, measured.missing) },
          { label: 'Confidence band', value: bandWords(measured.spread) },
        ]
      : null,
    model: rate ? { label: 'Model', value: etaModelWords(rate.floorMs, rate.slopeMsPerWeight) } : null,
    floor: null,
  };
}

/* ---------------- what it costs ---------------- */

export interface CostReading {
  /** The four figures, each with what it is. */
  facts: InsightFact[];
  /**
   * Ladder spend against the day cap, as the server sent them — the meter's
   * part and whole, the room left under it (`ladderLeftUsd`) and the cap's
   * own verdict (`overDayCap`, the rule `nextRung` refuses at). Null with no
   * cap set.
   */
  cap: { ladderUsd: number; capUsd: number; atCap: boolean; room: string } | null;
  /** The days, each at the total the server summed for it. */
  days: { name: string; value: number }[];
  /** The days with settled and ladder spend apart, for the numbers fold. */
  split: SpendView['series'];
  /** Each run against its own budget, narrowed to the plan in scope. */
  runs: SpendView['runs'];
}

export function costReading(spend: SpendView, plan?: string): CostReading {
  const { today, series } = spend;
  const cap = today.capUsd;
  return {
    facts: [
      { label: 'Settled today', value: money(today.settledUsd), hint: 'what the runs cost' },
      { label: 'Ladder today', value: money(today.ladderUsd), hint: 'what recovery cost on top' },
      {
        label: 'Day cap',
        value: cap == null ? 'none' : money(cap),
        hint: cap == null ? 'nothing refuses a rung on cost' : 'what the ladder may spend today',
      },
      {
        label: `Last ${plural(series.length, 'day')}`,
        value: spend.total ? money(spend.total.usd) : NOT_SAID,
        hint: 'settled and ladder together',
      },
    ],
    cap:
      cap == null
        ? null
        : {
            ladderUsd: today.ladderUsd,
            capUsd: cap,
            atCap: overDayCap(today),
            room: today.ladderLeftUsd == null ? NOT_SAID : money(today.ladderLeftUsd),
          },
    days: series.flatMap((day) => (day.usd == null ? [] : [{ name: day.day, value: day.usd }])),
    split: series,
    runs: plan ? spend.runs.filter((run) => run.slug === plan) : spend.runs,
  };
}

/* ---------------- how fast ---------------- */

export interface VelocityReading {
  /** The weeks exactly as the server bucketed them, oldest first. */
  weeks: Portfolio['velocity'];
  /** The first and the last week of the window. */
  from: string | null;
  to: string | null;
  gap: string | null;
  /** No week landed anything — a reading, and the empty state's cue. */
  empty: boolean;
  calendar: Portfolio['calendar'];
}

export function velocityReading(stats: Portfolio): VelocityReading {
  const weeks = stats.velocity;
  return {
    weeks,
    from: weeks[0]?.week ?? null,
    to: weeks.at(-1)?.week ?? null,
    gap: medianGapWords(stats.medianCycleDays),
    empty: weeks.every((week) => week.count === 0),
    calendar: stats.calendar,
  };
}

/* ---------------- what a session may spend ---------------- */

/** A share as the report prints it: one decimal, a space before the sign. */
const percent = (share: number): string => `${Math.round(share * 1000) / 10} %`;

/** One cap of the table: a session mode's turns or dollars, measured here beside shipped. */
export interface CapRow {
  /** `phase.turns` — one per row. */
  id: string;
  /** The mode and what it bounds: `phase turns`, `phase dollars`. */
  cap: string;
  measured: string;
  shipped: string;
  /** The server's words for how the figure in force was reached: the measured one's, else the shipped one's. */
  basis: string | null;
}

export interface SizingReading {
  /** The phase session's two caps, in one sentence. */
  answer: string;
  /** Each of those caps, with the server's words for how it was reached. */
  phase: InsightFact[];
  caps: CapRow[];
  /** The context model: the peak a session is sized to, its boot and work, and what it stands on. */
  context: InsightFact[];
  /** How each size's measured peaks sat against the model — empty while the model is the shipped one. */
  peaks: InsightFact[];
  /** Sessions per phase by size: the expected count, then its two halves and its basis. */
  sessions: InsightFact[];
}

const capFigure = (cap: SessionCap | undefined, unit: 'turns' | 'usd'): string | null =>
  cap ? (unit === 'usd' ? money(cap.value) : String(cap.value)) : null;

export function sizingReading(sizing: SessionSizing): SizingReading {
  const { turns, usd } = sizing.caps.phase;
  const measured = sizing.caps.measured?.modes ?? {};
  const shipped = sizing.caps.shipped.modes;
  // The shipped table's modes first, in its order, then any mode only this console measured.
  const modes = [...new Set([...Object.keys(shipped), ...Object.keys(measured)])];
  const caps = modes.flatMap((mode) =>
    (['turns', 'usd'] as const).flatMap((unit): CapRow[] => {
      const own = measured[mode]?.[unit];
      const theirs = shipped[mode]?.[unit];
      if (!own && !theirs) return [];
      return [
        {
          id: `${mode}.${unit}`,
          cap: `${mode} ${unit === 'usd' ? 'dollars' : 'turns'}`,
          measured: capFigure(own, unit) ?? 'not measured',
          shipped: capFigure(theirs, unit) ?? NOT_SAID,
          basis: (own ?? theirs)?.basis ?? null,
        },
      ];
    }),
  );
  const context = sizing.context;
  return {
    answer: `A phase session runs under ${plural(turns.value, 'turn')} and ${money(usd.value)}.`,
    phase: [
      { label: 'Turns', value: String(turns.value), ...(turns.basis ? { hint: turns.basis } : {}) },
      { label: 'Dollars', value: money(usd.value), ...(usd.basis ? { hint: usd.basis } : {}) },
    ],
    caps,
    context: [
      {
        label: 'Peak',
        value: `${weight(context.floor)} + ${context.slope.toFixed(2)} × weight`,
        hint: 'the context a session of that weight is sized to peak at',
      },
      {
        label: 'Boot',
        value: weight(context.boot),
        hint: context.bootMeasured
          ? 'the first call’s context, measured on this repository'
          : 'the first call’s context, as shipped',
      },
      { label: 'Work', value: weight(context.work), hint: 'what every phase session adds above its boot' },
      {
        label: 'Basis',
        value:
          context.basis === 'measured'
            ? `measured over ${plural(context.samples, 'fresh phase session')}`
            : 'the shipped model: too few sessions here to fit one',
      },
    ],
    peaks: (context.sizes ?? []).map((row) => ({
      label: row.size,
      value: `${weight(row.medianPeak)} median peak`,
      hint: `${row.ratio.toFixed(2)} of the model at ${weight(row.weight)} of weight, over ${plural(row.samples, 'session')}`,
    })),
    sessions: Object.entries(sizing.sessions).map(([size, row]) => ({
      label: size,
      value: `${row.expected.toFixed(2)} sessions a phase`,
      hint: `${row.noWrap.toFixed(2)} without a context wrap, ${row.wraps.toFixed(2)} with one, ${percent(row.wrapRate)} wrap, ${
        row.basis === 'measured' ? `measured over ${plural(row.phases, 'finished phase')}` : 'as shipped'
      }`,
    })),
  };
}

/* ---------------- this week ---------------- */

/**
 * The week's measurements as `phase-console report` prints them: a label, the
 * figure, and the rest of the server's sentence beside it.
 */
export function weekFacts(m: WeekMetrics): InsightFact[] {
  const eta = m.phaseEta;
  const baseline = `the recent-median baseline within 2× ${percent(eta.baseline.within2)}, MALE ${eta.baseline.male.toFixed(2)}`;
  const unrun = m.unrunVerification;
  return [
    {
      label: 'Stopped',
      value: `${percent(m.down.share)} of ${m.down.lifeHours} run-hours`,
      hint: `ended by a person ${m.down.endedBy.person} h, by the console ${m.down.endedBy.console} h, by a wait clock ${m.down.endedBy['wait-clock']} h, still stopped ${m.down.endedBy.open} h`,
    },
    {
      label: 'Avoidable stops',
      value: `${m.avoidable.hours} h`,
      hint: `failure streaks ${m.avoidable.byCause.streak} h, a lint that proved nothing ${m.avoidable.byCause['lint-crash']} h, a credential latched on an outage ${m.avoidable.byCause['credential-latch']} h`,
    },
    {
      label: 'Streak halts',
      value: String(m.streakHalts.total),
      hint: `${m.streakHalts.flagged} counted a rescued command (${m.streakHalts.byCause['rescued-command']}), a repeated phase (${m.streakHalts.byCause['repeated-phase']}) or a spent wait budget (${m.streakHalts.byCause['wait-budget']})`,
    },
    {
      label: 'Verify-failed halts',
      value: String(m.verifyFailed.halts),
      hint: `${m.verifyFailed.fromRescued} from a rescued command`,
    },
    {
      label: 'Spend',
      value: `${money(m.spend.bookedUsd)} booked, ${money(m.spend.finalUsd)} final`,
      hint: `over ${plural(m.spend.sessions, 'session')}, phantom ${money(m.spend.phantomUsd)} (${percent(m.spend.phantomShare)}), ${m.spend.mismatched} differ`,
    },
    {
      label: 'Queue',
      value: `${plural(m.queue.episodes, 'episode')}, ${m.queue.episodeHours} h`,
      hint: `recorded ${m.queue.recordedHours} h (${percent(m.queue.recordedShare)}), behind the run’s own lane ${m.queue.ownRunHours} h (${percent(m.queue.ownRunShare)}), serial ${m.queue.serialHours} h`,
    },
    {
      label: 'Holder estimate',
      value: `${plural(m.holderEta.waits, 'wait')}, ${m.holderEta.errorAtMedian}× off at the median`,
      hint: `realised over label ${m.holderEta.medianRealisedOverLabel}, low bound over realised ${m.holderEta.medianLowOverRealised}, low bound held ${percent(m.holderEta.lowCoverage)}, inside the band ${percent(m.holderEta.bandCoverage)}`,
    },
    {
      label: 'Phase estimate',
      value: eta.estimator
        ? `within 2× ${percent(eta.estimator.within2)}, MALE ${eta.estimator.male.toFixed(2)}`
        : 'not journalled',
      hint: `${plural(eta.records, 'phase')}, ${baseline}${eta.estimator ? '' : ', and a replay scores today’s estimator'}`,
    },
    { label: 'Stalls on finished lanes', value: String(m.stallsOnFinished.count) },
    {
      label: 'Ended at max_turns',
      value: String(m.closeoutCapResumes.maxTurnsEndings),
      hint: `${m.closeoutCapResumes.underCloseoutCap} of them resumes under the closeout cap`,
    },
    {
      label: 'Unrun verification',
      value: String(unrun.count),
      ...(unrun.phases.length
        ? { hint: unrun.phases.map((phase) => `${phase.slug} P${phase.phase}`).join(', ') }
        : {}),
    },
    {
      label: 'Model named',
      value: `${m.modelNamed.differs} of ${m.modelNamed.starts} starts differ`,
      hint: 'a phase start that ran on a model other than the one it named',
    },
    {
      label: 'Context re-read',
      value: `${m.context.cacheReadMTokens}M cache-read tokens`,
      hint: `over ${plural(m.context.calls, 'call')} in ${plural(m.context.sessions, 'session')}, ${m.context.meanContextK}K a call, the boot prefix ${
        m.context.bootShare === null ? 'not measured' : percent(m.context.bootShare)
      } of it (${plural(m.context.bootMeasured, 'session')} measured their boot)`,
    },
  ];
}
