/**
 * The ETA's back-test — the estimator ships only if it beats the naive
 * baseline it replaces (control-tower phase 58, #65, EB-1..2).
 *
 * The audit that found the old estimator wrong also found it LOSING to a
 * strawman: the median of a plan's last seven raw durations, sizes ignored,
 * scored MALE 0.72 and 68 % within ×2 against the EMA's 0.83 and 59 % over the
 * same 491 phases (`evidence/queries/eta/q8_alt_estimators.py`). So a new
 * estimator's claim is not that it is principled but that it is BETTER, and
 * this module is how that claim is checked: every measured phase is predicted
 * at its first boarding from the phases that had finished before it, by both
 * estimators, on the same evidence, and scored the audit's way —
 *
 * - **MALE** — the mean absolute log error, `mean |ln(actual ÷ estimate)|`;
 * - **within ×2** — the share whose estimate was within a factor of two.
 *
 * The evidence is what the console fits on: each phase's worked time over
 * every session that worked it (`evidenceOf`, a stored run re-measured from its
 * journal exactly as the boot pass does), with the finished phases that are not
 * measurements left out of both the evidence and the targets.
 *
 * `backtest` is pure; `recordsFromRuns` reads a console's stored runs (a
 * `runs/<instance>` directory) read-only. Run as a script it prints the
 * result for a console's runs and can write the anonymised corpus the test
 * replays:
 *
 *     node viewer/server/analysis/eta-backtest.ts --runs <state>/runs/<instance> --docs <repo> [--runs … --docs …] [--corpus <out.json>]
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parsePlan, type PhaseSize } from '../parse/plan.ts';
import { remeasureFromLedger, type LedgerLine } from '../runner/session-record.ts';
import { estimateMs, evidenceOf, rateFor, type EtaSample } from './stats.ts';

/** One measured phase, as the back-test replays it. */
export type BacktestRecord = {
  /** Which console's pool it belongs to — a prediction reads only its own console's history. */
  instance: string;
  plan: string;
  phase: number;
  size: PhaseSize;
  weight: number;
  /** The first boarding: the instant it is predicted at. */
  startedAt: string;
  endedAt: string;
  /** Worked time over every session that worked it. */
  workedMs: number;
  floorMs?: number;
};

export type BacktestScore = {
  n: number;
  /** Mean |ln(actual ÷ estimate)|. Lower is better. */
  male: number;
  /** Share of phases with the estimate within ×2. Higher is better. */
  within2: number;
  /** exp(median ln(actual ÷ estimate)): below 1 over-estimates, above 1 under-estimates. */
  medianRatio: number;
  /** Phases over-estimated by more than ×2, and under-estimated by more than ×2. */
  over2: number;
  under2: number;
};

export type BacktestResult = {
  records: number;
  estimator: BacktestScore;
  baseline: BacktestScore;
  /** The estimator's within-×2 share ≥ the baseline's AND its MALE ≤ the baseline's (EB-1). */
  ships: boolean;
};

/** The baseline's window: a plan's newest seven measured phases, as the audit's strawman. */
export const BASELINE_WINDOW = 7;
/** What the baseline says with no evidence at all — the audit's one hour. */
export const BASELINE_FALLBACK_MS = 3_600_000;

const byEnd = (a: BacktestRecord, b: BacktestRecord): number => a.endedAt.localeCompare(b.endedAt);

function median(list: number[]): number {
  const sorted = [...list].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * The naive recent-median: the median worked time of this plan's newest seven
 * measured phases before the target, else of the console's newest seven, else
 * an hour. No sizes, no weights, no model — which is the point.
 */
export function baselineEstimate(prior: readonly BacktestRecord[], target: BacktestRecord): number {
  const own = prior.filter((r) => r.plan === target.plan);
  const window = (own.length ? own : prior).slice(-BASELINE_WINDOW);
  return window.length ? median(window.map((r) => r.workedMs)) : BASELINE_FALLBACK_MS;
}

const sampleOf = (r: BacktestRecord): EtaSample => ({
  weight: r.weight,
  durationMs: r.workedMs,
  at: r.endedAt,
  size: r.size,
  ...(r.floorMs ? { floorMs: r.floorMs } : {}),
});

/**
 * The estimator the console ships, as it would have answered at the target's
 * boarding: the pool's shape (every plan's newest measured phases on this
 * console) at this plan's own level, unbucketed — the model is scored, not the
 * label's rounding.
 */
export function modelEstimate(prior: readonly BacktestRecord[], target: BacktestRecord): number {
  const rate = rateFor(prior.filter((r) => r.plan === target.plan).map(sampleOf), prior.map(sampleOf));
  return estimateMs(rate, target.weight, target.floorMs);
}

/** The audit's scoring over `[actual, estimate]` pairs. */
export function scorePairs(pairs: readonly (readonly [number, number])[]): BacktestScore {
  const logs = pairs.filter(([a, e]) => a > 0 && e > 0).map(([a, e]) => Math.log(a / e));
  const n = logs.length;
  if (!n) return { n: 0, male: 0, within2: 0, medianRatio: 1, over2: 0, under2: 0 };
  const two = Math.log(2);
  return {
    n,
    male: logs.reduce((s, x) => s + Math.abs(x), 0) / n,
    within2: logs.filter((x) => Math.abs(x) <= two).length / n,
    medianRatio: Math.exp(median(logs)),
    over2: logs.filter((x) => x < -two).length,
    under2: logs.filter((x) => x > two).length,
  };
}

/**
 * Replay every record: predicted at its first boarding, by both estimators,
 * from the records of the same console that had ENDED by then (so a phase is
 * never evidence for itself, and a concurrent one is not evidence yet).
 */
export function backtest(records: readonly BacktestRecord[]): BacktestResult {
  const byInstance = new Map<string, BacktestRecord[]>();
  for (const record of records) byInstance.set(record.instance, [...(byInstance.get(record.instance) ?? []), record]);
  const model: [number, number][] = [];
  const naive: [number, number][] = [];
  for (const list of byInstance.values()) {
    const ended = [...list].sort(byEnd);
    for (const target of list) {
      const prior = ended.filter((r) => r.endedAt < target.startedAt);
      model.push([target.workedMs, modelEstimate(prior, target)]);
      naive.push([target.workedMs, baselineEstimate(prior, target)]);
    }
  }
  const estimator = scorePairs(model);
  const baseline = scorePairs(naive);
  return {
    records: records.length,
    estimator,
    baseline,
    ships: estimator.within2 >= baseline.within2 && estimator.male <= baseline.male,
  };
}

/** A phase's size, weight and declared floor, as the plan file says. */
export type PlanPhaseFacts = ReadonlyMap<number, { size: PhaseSize; weight: number; floorMs?: number }>;

/** Per-size weights — `scripts/sizing.env`'s, which the caller passes so this module reads no file of its own. */
export type SizeWeights = { S: number; M: number; L: number };

/** The facts `recordsFromRuns` needs from a plan file: each phase's size (default M), weight and declared floor. */
export function planFacts(text: string, slug: string, weights: SizeWeights): PlanPhaseFacts {
  const plan = parsePlan(text, slug, `${slug}.md`);
  const out = new Map<number, { size: PhaseSize; weight: number; floorMs?: number }>();
  for (const row of plan.graph) {
    const phase = plan.phases[row.phase];
    const size = phase?.size ?? 'M';
    const floorMin = (phase as { wallClockFloorMin?: number } | undefined)?.wallClockFloorMin;
    out.set(row.phase, { size, weight: weights[size], ...(floorMin ? { floorMs: floorMin * 60_000 } : {}) });
  }
  return out;
}

function readLines(path: string): LedgerLine[] {
  if (!existsSync(path)) return [];
  const lines: LedgerLine[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line) continue;
    try { lines.push(JSON.parse(line) as LedgerLine); } catch { /* a half-written tail */ }
  }
  return lines;
}

/**
 * Every measured phase in a console's stored runs (`runs/<instance>`),
 * read-only. Each run is re-measured from its own journal IN MEMORY — the same
 * `remeasureFromLedger` the boot pass writes back — so a phase finished by its
 * resume or closeout carries every session's time. Finished phases that are
 * not measurements (`evidenceOf`) are counted in `missing` and left out.
 * `factsOf` answers a plan's facts, or null for a plan no longer on disk.
 */
export function recordsFromRuns(
  runsDir: string,
  instance: string,
  factsOf: (slug: string) => PlanPhaseFacts | null,
): { records: BacktestRecord[]; missing: number } {
  const records: BacktestRecord[] = [];
  let missing = 0;
  if (!existsSync(runsDir)) return { records, missing };
  for (const slug of readdirSync(runsDir).sort()) {
    const dir = join(runsDir, slug);
    if (!statSync(dir).isDirectory()) continue;
    const facts = factsOf(slug);
    if (!facts) continue;
    for (const file of readdirSync(dir).sort()) {
      const match = /^run-([0-9a-z]+)\.json$/.exec(file);
      if (!match) continue;
      let state: { clockModel?: number; phases: Record<string, Record<string, unknown> | undefined> };
      try { state = JSON.parse(readFileSync(join(dir, file), 'utf8')); } catch { continue; }
      if (!state?.phases) continue;
      remeasureFromLedger(state, readLines(join(dir, `run-${match[1]}.jsonl`)));
      for (const record of Object.values(state.phases)) {
        if (!record || record.status !== 'done' || typeof record.phase !== 'number') continue;
        const fact = facts.get(record.phase);
        if (!fact) continue;
        const verdict = evidenceOf(record);
        if ('missing' in verdict) { missing += 1; continue; }
        const startedAt = (record.startedAt ?? record.attemptStartedAt) as string | undefined;
        const endedAt = (record.endedAt ?? record.attemptEndedAt) as string | undefined;
        if (typeof startedAt !== 'string' || typeof endedAt !== 'string') { missing += 1; continue; }
        records.push({
          instance, plan: slug, phase: record.phase, size: fact.size, weight: fact.weight,
          startedAt, endedAt, workedMs: Math.round(verdict.durationMs),
          ...(fact.floorMs ? { floorMs: fact.floorMs } : {}),
        });
      }
    }
  }
  return { records, missing };
}

/**
 * The records with every name taken out — consoles `console-a`, `console-b`…,
 * plans `plan-01`… in first-seen order — which is what the committed corpus
 * holds. Times, sizes, weights and worked time are the measurement; names are not.
 */
export function anonymise(records: readonly BacktestRecord[]): BacktestRecord[] {
  const instances = new Map<string, string>();
  const plans = new Map<string, string>();
  return records.map((r) => {
    if (!instances.has(r.instance)) instances.set(r.instance, `console-${String.fromCharCode(97 + instances.size)}`);
    const key = `${r.instance}/${r.plan}`;
    if (!plans.has(key)) plans.set(key, `plan-${String(plans.size + 1).padStart(2, '0')}`);
    return { ...r, instance: instances.get(r.instance)!, plan: plans.get(key)! };
  });
}

function main(argv: string[]): void {
  const pairs: { runs: string; docs: string }[] = [];
  let corpus: string | undefined;
  const weights: SizeWeights = { S: 15_000, M: 40_000, L: 90_000 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--runs') pairs.push({ runs: argv[++i]!, docs: '' });
    else if (argv[i] === '--docs' && pairs.length) pairs[pairs.length - 1]!.docs = argv[++i]!;
    else if (argv[i] === '--corpus') corpus = argv[++i];
  }
  const all: BacktestRecord[] = [];
  let missing = 0;
  for (const { runs, docs } of pairs) {
    const instance = runs.replace(/\/+$/, '').split('/').pop() ?? runs;
    const read = recordsFromRuns(runs, instance, (slug) => {
      const path = join(docs, 'docs', 'plans', `${slug}.md`);
      return existsSync(path) ? planFacts(readFileSync(path, 'utf8'), slug, weights) : null;
    });
    all.push(...read.records);
    missing += read.missing;
  }
  const result = backtest(all);
  process.stdout.write(`${JSON.stringify({ ...result, missing }, null, 2)}\n`);
  if (corpus) {
    const body = { note: 'Anonymised measured phases for the ETA back-test (eta-backtest.test.ts).', records: anonymise(all) };
    writeFileSync(corpus, `${JSON.stringify(body)}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
