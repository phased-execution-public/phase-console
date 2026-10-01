/**
 * The holder ETA's back-test (control-tower phase 60, #63, HE-3).
 *
 * A queue card says how long its holder has. It used to quote the holder's
 * WHOLE PLAN — 24.7× the real wait at the median, and for a sibling of the
 * waiter's own run a figure that counted the waiter itself. The scope is
 * released when the holder PHASE ends, so the figure is now that phase's
 * remaining working time: its estimate under phase 58's model, minus what it
 * has already worked (`holderRemaining` in `stats.ts`).
 *
 * This module is how that claim is checked against what really happened.
 * Every admitted wait in a console's stored journals — `phase.queued` naming a
 * head holder phase, then `phase.admitted` — is a pair: the realised wait, and
 * the label the card would have shown at the moment it queued. The holder's
 * worked time at that moment is summed from its own `phase.session` windows,
 * and its estimate is the model fitted on the phases that had ENDED by then.
 *
 * `holderWaitsFromRuns` reads a console's stored runs read-only; `scoreWaits`
 * is pure. Run as a script it prints the score, and can write the anonymised
 * corpus `holder-eta.test.ts` replays:
 *
 *     node viewer/server/analysis/holder-eta.ts --runs <state>/runs/<instance> --docs <repo> [--runs … --docs …] [--corpus <out.json>]
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PHASE_WORK_MODES } from '../../shared/phase-clocks.js';
import type { PhaseSize } from '../parse/plan.ts';
import { planFacts, recordsFromRuns, scorePairs, type BacktestRecord, type BacktestScore, type PlanPhaseFacts, type SizeWeights } from './eta-backtest.ts';
import { estimateMs, holderRemaining, rateFor, type EtaSample } from './stats.ts';

/** One admitted wait, as the back-test replays it — every name already anonymised in the corpus. */
export type HolderWait = {
  instance: string;
  /** The holder's plan and phase — what the label is about. */
  plan: string;
  phase: number;
  size: PhaseSize;
  /** The holder is a phase of the waiter's own run. */
  own: boolean;
  queuedAt: string;
  /** The realised wait: `phase.queued` to `phase.admitted`. */
  waitedMs: number;
  /** The holder phase's estimate at `queuedAt`, from the phases that had ended by then. */
  estimateMs: number;
  /** That reading's band spread (`RateReading.spread`). */
  spread: number;
  /** What the holder phase had already worked at `queuedAt`. */
  workedMs: number;
};

/** The score: the audit's MALE and ×2 share, the median realised ÷ label, and how often the wait fell inside the band. */
export type HolderScore = BacktestScore & {
  /** Median of realised wait ÷ the label's point — ≤ 2 is HE-3's bar. */
  medianRealisedOverLabel: number;
  /** Share of waits inside the label's [low, high] band. */
  bandCoverage: number;
  /** Waits whose holder had already worked past its estimate. */
  overrun: number;
};

type Line = { time?: string; event?: string; phase?: number; data?: Record<string, unknown> };

function readLines(path: string): Line[] {
  const out: Line[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line) as Line); } catch { /* a half-written tail */ }
  }
  return out;
}

function median(list: number[]): number {
  const sorted = [...list].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const sampleOf = (r: BacktestRecord): EtaSample => ({
  weight: r.weight, durationMs: r.workedMs, at: r.endedAt, size: r.size, ...(r.floorMs ? { floorMs: r.floorMs } : {}),
});

/**
 * Every admitted wait in a console's stored runs whose head holder names a
 * phase the plan file still describes, with the holder's estimate and worked
 * time at the moment the wait began. Read-only.
 */
export function holderWaitsFromRuns(
  runsDir: string,
  instance: string,
  factsOf: (slug: string) => PlanPhaseFacts | null,
): HolderWait[] {
  if (!existsSync(runsDir)) return [];
  const { records } = recordsFromRuns(runsDir, instance, factsOf);
  const ended = [...records].sort((a, b) => a.endedAt.localeCompare(b.endedAt));
  /** `plan:phase` → the windows its sessions worked, [start, end] ms. */
  const windows = new Map<string, [number, number][]>();
  const journals: { slug: string; runId: string; lines: Line[] }[] = [];
  for (const slug of readdirSync(runsDir).sort()) {
    const dir = join(runsDir, slug);
    if (!statSync(dir).isDirectory()) continue;
    for (const file of readdirSync(dir).sort()) {
      const match = /^run-([0-9a-z]+)\.jsonl$/.exec(file);
      if (!match) continue;
      const lines = readLines(join(dir, file));
      journals.push({ slug, runId: match[1]!, lines });
      for (const line of lines) {
        if (line.event !== 'phase.session' || typeof line.phase !== 'number' || !line.time) continue;
        const mode = String(line.data?.mode ?? 'phase');
        if (!(PHASE_WORK_MODES as readonly string[]).includes(mode)) continue;
        const end = Date.parse(line.time);
        const ms = Number(line.data?.ms ?? 0);
        if (!Number.isFinite(end) || !(ms > 0)) continue;
        const key = `${slug}:${line.phase}`;
        windows.set(key, [...(windows.get(key) ?? []), [end - ms, end]]);
      }
    }
  }
  const workedBefore = (key: string, at: number): number => (windows.get(key) ?? [])
    .reduce((sum, [start, end]) => sum + Math.max(0, Math.min(end, at) - start), 0);

  const out: HolderWait[] = [];
  for (const { slug, runId, lines } of journals) {
    /** phase → the open wait. */
    const open = new Map<number, { at: string; holder: { slug: string; phase: number; owner: string } }>();
    for (const line of lines) {
      if (typeof line.phase !== 'number' || !line.time) {
        // A run-level withdrawal ends every open wait with no admission.
        if (String(line.event ?? '').endsWith('-withdrew')) open.clear();
        continue;
      }
      if (line.event === 'phase.queued') {
        const head = (line.data?.waitingOn as { slug?: string; phase?: number | null; owner?: string }[] | undefined)?.[0];
        if (head?.slug && typeof head.phase === 'number') {
          open.set(line.phase, { at: line.time, holder: { slug: head.slug, phase: head.phase, owner: String(head.owner ?? '') } });
        } else open.delete(line.phase);
        continue;
      }
      if (line.event === 'phase.not-started' || line.event === 'phase.lock-wait-capped' || line.event === 'phase.queue-closed') {
        if (line.event !== 'phase.queue-closed' || line.data?.outcome !== 'admitted') open.delete(line.phase);
        continue;
      }
      if (line.event !== 'phase.admitted') continue;
      const wait = open.get(line.phase);
      open.delete(line.phase);
      if (!wait) continue;
      const facts = factsOf(wait.holder.slug)?.get(wait.holder.phase);
      if (!facts) continue;
      const at = Date.parse(wait.at);
      const waitedMs = Date.parse(line.time) - at;
      if (!(waitedMs > 0)) continue;
      const prior = ended.filter((r) => Date.parse(r.endedAt) < at);
      const rate = rateFor(prior.filter((r) => r.plan === wait.holder.slug).map(sampleOf), prior.map(sampleOf));
      out.push({
        instance, plan: wait.holder.slug, phase: wait.holder.phase, size: facts.size,
        own: wait.holder.owner === `autopilot/${runId}`,
        queuedAt: wait.at, waitedMs,
        estimateMs: Math.round(estimateMs(rate, facts.weight, facts.floorMs)),
        spread: rate.spread,
        workedMs: Math.round(workedBefore(`${wait.holder.slug}:${wait.holder.phase}`, at)),
      });
    }
  }
  return out;
}

/** Score the label a card would have shown against every realised wait. */
export function scoreWaits(waits: readonly HolderWait[]): HolderScore {
  const pairs: [number, number][] = [];
  let inside = 0;
  let overrun = 0;
  const ratios: number[] = [];
  for (const wait of waits) {
    const label = holderRemaining(wait.estimateMs, wait.spread, wait.workedMs);
    if (label.overrun) overrun += 1;
    pairs.push([wait.waitedMs, label.remainingMs]);
    ratios.push(wait.waitedMs / label.remainingMs);
    if (wait.waitedMs >= label.lowMs && wait.waitedMs <= label.highMs) inside += 1;
  }
  return {
    ...scorePairs(pairs),
    medianRealisedOverLabel: ratios.length ? median(ratios) : 1,
    bandCoverage: waits.length ? inside / waits.length : 0,
    overrun,
  };
}

/** The waits with every name taken out — `console-a`…, `plan-01`… in first-seen order. */
export function anonymiseWaits(waits: readonly HolderWait[]): HolderWait[] {
  const instances = new Map<string, string>();
  const plans = new Map<string, string>();
  return waits.map((w) => {
    if (!instances.has(w.instance)) instances.set(w.instance, `console-${String.fromCharCode(97 + instances.size)}`);
    const key = `${w.instance}/${w.plan}`;
    if (!plans.has(key)) plans.set(key, `plan-${String(plans.size + 1).padStart(2, '0')}`);
    return { ...w, instance: instances.get(w.instance)!, plan: plans.get(key)! };
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
  const all: HolderWait[] = [];
  for (const { runs, docs } of pairs) {
    const instance = runs.replace(/\/+$/, '').split('/').pop() ?? runs;
    all.push(...holderWaitsFromRuns(runs, instance, (slug) => {
      const path = join(docs, 'docs', 'plans', `${slug}.md`);
      return existsSync(path) ? planFacts(readFileSync(path, 'utf8'), slug, weights) : null;
    }));
  }
  const byOwn = (own: boolean): HolderScore => scoreWaits(all.filter((w) => w.own === own));
  process.stdout.write(`${JSON.stringify({ all: scoreWaits(all), ownRun: byOwn(true), otherRun: byOwn(false) }, null, 2)}\n`);
  if (corpus) {
    const body = { note: 'Anonymised admitted queue waits for the holder-ETA back-test (holder-eta.test.ts).', waits: anonymiseWaits(all) };
    writeFileSync(corpus, `${JSON.stringify(body)}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
