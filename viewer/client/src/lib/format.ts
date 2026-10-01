/**
 * The small formatters, in one place.
 *
 * Ported from `web/components/ui.js`, where they sat among the components and
 * were therefore unreachable from anything that did not want a rendering
 * runtime — including a test.
 */

import type { EtaBasis, EtaEstimate, HolderEtaView } from './api';
import { formatInterval } from '../../../shared/interval-format.js';

/** `310000` → `310K`. A weight is always tokens, and always rounded. */
export function weight(tokens: number | undefined): string {
  if (!tokens) return '0';
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
  return String(tokens);
}

/** What is left of a lock's lease, at the precision a lease is worth. */
export function countdown(untilMs: number | undefined): string {
  if (!untilMs) return '';
  const delta = untilMs - Date.now();
  if (delta <= 0) return 'expired';
  const minutes = Math.round(delta / 60_000);
  return minutes >= 60 ? `${Math.round(minutes / 60)}h left` : `${minutes}m left`;
}

/**
 * `1 phase` / `3 phases` — the plural nobody wants to write inline twice.
 *
 * `many` for the words English does not pluralise with an `s`. Any local
 * two-argument `plural` is this function with the third argument missing.
 */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** `03` — a phase number as a departures board writes it. */
export const pad2 = (n: number | string): string => String(n).padStart(2, '0');

/* ---------------- clocks ----------------
 * Four of these, deliberately, because they answer different questions. A
 * running phase wants a stopwatch (`elapsed`), a finished one wants a settled
 * wall-clock (`duration`), a tool call runs from milliseconds to minutes so it
 * needs its own (`toolTime`), and a figure read out in a sentence wants units
 * rather than colons (`elapsedWords`). One format cannot serve all four without
 * being wrong for three — but the three interval ones share ONE rounding rule:
 * each delegates to `shared/interval-format.js` (`clock`, `table`, `prose`),
 * so they differ in precision and never in direction (#28). */

/** `0:07` / `12:03` / `1:04:11` — a stopwatch, for something still running. */
export function elapsed(ms: number): string {
  return formatInterval(ms, 'clock');
}

/** Wall-clock at the precision someone reading a phase table cares about. */
export function duration(ms: number): string {
  // The table register: one rounding rule (floor) with the other two, so a
  // phase that reads 1:59 on its stopwatch can no longer read `2m` here (#28).
  return formatInterval(ms, 'table');
}

/**
 * `47s` / `12m 03s` / `1h 04m` — a stopwatch read out loud rather than as a clock.
 *
 * The same interval `elapsed` renders, in the register a sentence wants: an
 * elapsed figure next to a label on a card reads as a clock and `12:03` is
 * unambiguous, but the same string inside prose reads as a time of day. The
 * seconds stay below the hour because this is used on things that are still
 * running, where a figure that only moves once a minute looks stuck.
 *
 * An unmeasurable interval is the em-dash, never `0:00`: a phase whose start
 * the console never recorded has not been running for no time.
 */
export function elapsedWords(ms: number): string {
  return formatInterval(ms, 'prose');
}

/**
 * The one interval formatter, re-exported: this file is the client's only door
 * to `shared/interval-format.js` (`format.test.ts` scans for a second), so a
 * surface that needs a register the three helpers above do not name asks here.
 */
export { formatInterval };

/**
 * A duration with the verb that says what it measures (control-tower phase 19,
 * #28). "12m 03s" beside a run is five questions — running for it, halted that
 * long ago, queued, worked? — and the strip answers exactly one of them, so the
 * verb travels WITH the figure rather than beside it in a label a narrow row
 * drops first.
 */
export interface LabelledClock {
  /** What the interval measured, as the verb a sentence leads with: `ran`, `halted`, `queued`. */
  verb: string;
  /** The interval itself. `null` (or anything unmeasurable) when the console never measured it. */
  ms: number | null;
  /** `for` — the verb lasted this long, and may still be; `ago` — the verb happened this long ago. */
  tense: 'for' | 'ago';
  /** Which named clock it is (`PHASE_CLOCK_LABELS`), for a title that says where the figure came from. */
  label?: string;
}

/**
 * `running 12m 03s` · `ran 1h 04m` · `halted 12m 3s ago` · `queued —`.
 *
 * A span reads in the `prose` register (padded, so a live figure does not
 * jitter in width); a moment in the `table` register with "ago". One rounding
 * rule under both — the floor — so a labelled clock never reads ahead of the
 * stopwatch beside it. Unmeasured keeps its verb and says `—`, never `0`.
 */
export function clockWords(clock: LabelledClock): string {
  const ms = clock.ms ?? Number.NaN;
  const figure = formatInterval(ms, clock.tense === 'for' ? 'prose' : 'table');
  if (!Number.isFinite(ms) || ms < 0) return `${clock.verb} —`;
  return clock.tense === 'ago' ? `${clock.verb} ${figure} ago` : `${clock.verb} ${figure}`;
}

/** A tool call: `840ms` / `2.4s` / `6m`. */
export function toolTime(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

/**
 * `14:07:52` — a wall clock for a log line, in the reader's own zone.
 *
 * Deliberately not `relativeTime`: "4 minutes ago" is the right register for a
 * card that names one moment, and the wrong one for a column of five hundred
 * lines, where what a reader wants is to line two of them up and see the gap.
 */
export function clockTime(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '--:--:--';
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

const UNITS: [number, string][] = [
  [60_000, 'minute'],
  [3_600_000, 'hour'],
  [86_400_000, 'day'],
  [604_800_000, 'week'],
  [2_629_800_000, 'month'],
  [31_557_600_000, 'year'],
];

/** `just now` / `4 minutes ago`, falling back to a date once that stops helping. */
export function relativeTime(ms: number | undefined): string {
  if (!ms || Number.isNaN(ms)) return '—';
  const delta = Date.now() - ms;
  if (delta < 60_000) return 'just now';
  for (let i = 0; i < UNITS.length; i++) {
    const [size, name] = UNITS[i];
    const next = UNITS[i + 1]?.[0] ?? Infinity;
    if (delta < next) {
      const value = Math.round(delta / size);
      return `${value} ${name}${value === 1 ? '' : 's'} ago`;
    }
  }
  return new Date(ms).toISOString().slice(0, 10);
}

/** `$1.20`. Absent and zero are different things — only the caller knows which. */
export const money = (usd: number | null | undefined): string => `$${(usd ?? 0).toFixed(2)}`;

/**
 * Bytes as a person says them — `412 MB`, `1.8 GB`.
 *
 * Absent in, absent out. `du` answers `undefined` for a tree it could not walk,
 * and `0 B` for a checkout that exists is a measurement rather than a gap; the
 * two must not collapse into one string. Powers of 1024 with the decimal names,
 * which is what every disk tool on the operator's machine prints.
 */
export function bytes(n: number | null | undefined): string | undefined {
  if (n == null || !Number.isFinite(n) || n < 0) return undefined;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // Whole numbers past KB: a checkout is 412 MB, never 412.3 MB — the extra
  // digit is noise on a figure that moves every time a session writes a file.
  const shown =
    unit === 0 ? String(Math.round(value)) : value < 10 ? value.toFixed(1) : String(Math.round(value));
  return `${shown} ${units[unit]}`;
}

/**
 * An absolute path as `~/…`, when it is under the server's home.
 *
 * The privacy rule the Settings cards already follow, in one place instead of
 * three copies of the same conditional: a screenshot of a page carries no
 * username, and `~/work/.pe-wt/ccp` is the form an operator can paste into a
 * shell anyway. Anything outside `$HOME` is printed exactly as it is — a
 * `/tmp` or `/Volumes` path shortened would be a lie about where it is.
 *
 * This is the DISPLAY form. `portablePath` in `features/settings/start-command`
 * is the shell form (`"$HOME/…"`, quoted); they are different jobs.
 */
export function homePath(path: string | undefined, home: string | undefined): string | undefined {
  if (!path) return undefined;
  if (home && (path === home || path.startsWith(`${home}/`))) return `~${path.slice(home.length)}`;
  return path;
}

/* ---------------- estimates ----------------
 * An estimate is rendered in exactly one place, here, because the thing most
 * easily got wrong about one is not the arithmetic — the server did that — but
 * how much of a claim it sounds like. Five surfaces printing `eta.label` would
 * be five chances to drop the hedge, and a hedge dropped is a guess presented as
 * a measurement. */

/**
 * What each basis is worth, in the words a reader needs after the number.
 *
 * `plan` still says "(estimate)" rather than nothing: even the strongest reading
 * here is a model's throughput on work nobody has looked at yet.
 */
const BASIS_SUFFIX: Record<EtaBasis, string> = {
  plan: '(estimate)',
  portfolio: '(from other plans)',
  heuristic: '(rough guess)',
};

/** Longer than the bucket it came from deserves would be a lie about precision. */
function coarse(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = ms / 3_600_000;
  if (hours < 24) return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} h`;
  const days = ms / 86_400_000;
  return `${days < 10 ? days.toFixed(1) : Math.round(days)} d`;
}

/**
 * `~40 min–1.5 h of work left (estimate)` — a range, its clock, and how much
 * to believe it.
 *
 * The server has already snapped both ends to a bucket a person would say out
 * loud, so this only formats and hedges. A collapsed range (both ends in the
 * same bucket) prints once rather than as `~5 min–5 min`. `of work` names the
 * clock: working time, the remaining phases back to back — never a calendar
 * date, which is `Forecast.label` (`lib/api/plans`) and reads differently.
 */
export function etaLabel(lowMs: number, highMs: number, basis: EtaBasis): string {
  const range = lowMs === highMs ? `~${coarse(highMs)}` : `~${coarse(lowMs)}–${coarse(highMs)}`;
  return `${range} of work left ${BASIS_SUFFIX[basis] ?? BASIS_SUFFIX.heuristic}`;
}

/** `~40 min of work` — one phase's own estimate, with no hedge and no "left". */
export function etaPoint(ms: number): string {
  return `~${coarse(ms)} of work`;
}

/** Where the number came from, in a sentence, for the `title` of any of them. */
export function etaTitle(eta: EtaEstimate): string {
  const evidence =
    eta.basis === 'plan'
      ? `${plural(eta.samples, 'measured phase')} of this plan`
      : eta.basis === 'portfolio'
        ? `${plural(eta.samples, 'measured phase')} across other plans — this one has none yet`
        : 'no measured phase anywhere yet, so this is the size tags alone';
  // A finished phase can still teach the rate nothing (a closeout-only
  // completion, a duration nobody recorded) — said here rather than silently
  // dropped, the same rule the server's own evidence list follows.
  const missingNote = eta.missing
    ? ` ${plural(eta.missing, 'finished phase')} had no usable measurement and ${eta.missing === 1 ? 'was' : 'were'} left out.`
    : '';
  return (
    `From ${evidence}, against ${weight(eta.remainingWeight)} of remaining weight. ` +
    'Working time: the remaining phases back to back, nothing parked or overnight. Each phase is a ' +
    'floor plus a slope fitted to the measured phases, deliberately coarse.' +
    missingNote
  );
}

/**
 * How long a queue holder has, in the words a card says it (control-tower
 * phase 60, #63): the holder PHASE's remaining time as its own sentence
 * (`P3 has ~25–50 min of work left`), or — where no phase is known, and on a
 * figure written before 6.0 — its plan's, always prefixed `plan remaining` so it
 * can never be read as the wait. Empty when nothing is known.
 */
export function holderEtaText(eta: HolderEtaView | undefined, phase: number | null | undefined): string {
  const label = eta?.label;
  if (!label) return '';
  if (eta.of === 'phase') return `${phase == null ? 'that phase' : `P${phase}`} has ${label}`;
  return label.startsWith('plan remaining') ? label : `plan remaining ${label.replace(/ left$/, '')}`;
}
