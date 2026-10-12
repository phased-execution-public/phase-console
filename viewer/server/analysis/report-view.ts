/**
 * The week in numbers as `GET /api/report` answers it (quiet-console phase 25):
 * `weekReportFromDir` over this console's stored runs — the week report with
 * its ETA backtest (`metrics.phaseEta`) and its holder ETA
 * (`metrics.holderEta`) folded in, `?replay=1` re-deriving them with today's
 * models — remembered for five minutes per question. The fold reads every
 * journal the console holds, and a page that re-renders must not read them
 * all again; the CLI's `phase-console report` asks the same function and
 * remembers nothing.
 */

import {
  REPLAY_RULES, planFactsReader, weekReportFromDir, type WeekReport, type WeekReportOptions,
} from './week-report.ts';

/** How long one question's answer stands before the journals are read again. */
export const REPORT_MEMO_MS = 5 * 60_000;

/** The window a question that names no `since` covers: the week before `until`. */
export const REPORT_DEFAULT_DAYS = 7;

/** Distinct questions remembered at once — the oldest goes first. */
const MEMO_ENTRIES = 8;

/** What the request asked, as it asked it: two instants and whether to replay. */
export type ReportQuery = { since?: string | null; until?: string | null; replay?: boolean };

/** Where the console's runs and plans are, and what it is called. */
export type ReportSource = { runsDir: string; docsRoot: string; scriptsDir: string; instance: string };

export type ReportAnswer = {
  report: WeekReport;
  /** When the journals behind this answer were read. */
  readAt: string;
  /** Whether this answer is a remembered one — the same question inside `REPORT_MEMO_MS`. */
  cached: boolean;
};

/** A `since` or `until` that is not an instant — the route answers 400 with it. */
export class ReportQueryError extends Error {}

const instant = (value: string | null | undefined, name: string): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const at = Date.parse(value);
  if (!Number.isFinite(at)) throw new ReportQueryError(`${name} must be an ISO instant (got ${value})`);
  return at;
};

/**
 * The memo, one per console. `read` is the fold and `now` the clock — both
 * swapped by a test that counts the reads and moves the clock past the five
 * minutes.
 */
export class ReportMemo {
  private readonly entries = new Map<string, { at: number; report: WeekReport }>();
  private readonly read: (runsDir: string, options: WeekReportOptions) => WeekReport;
  private readonly now: () => number;

  constructor(
    read: (runsDir: string, options: WeekReportOptions) => WeekReport = weekReportFromDir,
    now: () => number = Date.now,
  ) {
    this.read = read;
    this.now = now;
  }

  answer(source: ReportSource, query: ReportQuery): ReportAnswer {
    const now = this.now();
    const untilAt = instant(query.until, 'until') ?? now;
    const sinceAt = instant(query.since, 'since') ?? untilAt - REPORT_DEFAULT_DAYS * 24 * 60 * 60_000;
    if (sinceAt >= untilAt) throw new ReportQueryError('since must come before until');
    const key = [source.runsDir, query.since ?? '', query.until ?? '', query.replay ? 'replay' : ''].join('\u0000');
    const hit = this.entries.get(key);
    if (hit && now - hit.at < REPORT_MEMO_MS) return { report: hit.report, readAt: new Date(hit.at).toISOString(), cached: true };
    const report = this.read(source.runsDir, {
      instance: source.instance,
      since: new Date(sinceAt).toISOString(),
      until: new Date(untilAt).toISOString(),
      replay: query.replay ? REPLAY_RULES : [],
      factsOf: planFactsReader(source.docsRoot, source.scriptsDir),
    });
    this.entries.delete(key);
    this.entries.set(key, { at: now, report });
    while (this.entries.size > MEMO_ENTRIES) this.entries.delete(this.entries.keys().next().value!);
    return { report, readAt: new Date(now).toISOString(), cached: false };
  }
}
