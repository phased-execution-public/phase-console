/**
 * The week in numbers (control-tower phase 64, AUD-37, WR-1..17).
 *
 * The autopilot-week audit measured one week of two consoles with forty
 * throwaway scripts: runs down 35 % / 47 % of their working life, ≈ 20.8 h of
 * it after stops that carried no new information, a failure streak that
 * counted endings, a resumed session's cost booked twice, a queue card that
 * quoted a whole plan. This module measures the same twelve things in one
 * read-only pass over a console's stored runs, so anybody can ask again:
 *
 *     phase-console report <instance> --since <iso> [--until <iso>] [--replay] [--json]
 *
 * `--replay` re-derives four of them with TODAY's models over the old
 * journals, which is how the plan's acceptance targets (§End-to-end
 * verification item 10) are measured without waiting a week. Each rule is
 * the code the console runs, not a copy of it:
 *
 * - `streak` — phase 45: a rescued command is green (`verificationVerdict`), a
 *   streak counts distinct phases failed on their merits (`isMeritFailure`),
 *   and a spent wait budget is a park, not a failure;
 * - `spend` — phase 46: a resumed session books only what its running total
 *   added (`bookedDelta`);
 * - `eta` — phase 58: the fitted estimator against the naive recent median
 *   (`modelEstimate`, `baselineEstimate`, `scorePairs`);
 * - `holder` — phase 60: a queue card quotes the holder PHASE's remaining work
 *   (`holderRemaining`), a wait behind the run's own lane is serial rather
 *   than contention, and every queue episode records its wait.
 *
 * It reads and never writes (WR-17): nothing under the state directory is
 * created, touched or locked, and a live console is never asked.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { OPERATOR_DOOR, isMeritFailure } from '../../shared/run-lifecycle.js';
import { isTransportFailure } from '../runner/errors.ts';
import { bookedDelta } from '../runner/session-record.ts';
import type { VerifyRun } from '../runner/state.ts';
import { verificationVerdict } from '../runner/verify.ts';
import {
  baselineEstimate, modelEstimate, planFacts, recordsFromRuns, scorePairs,
  type BacktestRecord, type BacktestScore, type PlanPhaseFacts,
} from './eta-backtest.ts';
import { loadSizing } from './graph.ts';
import { holderWaitsFromRuns, type HolderWait } from './holder-eta.ts';
import { holderRemaining } from './stats.ts';

/** The four models `--replay` re-derives with, by the phase that shipped each. */
export type ReplayRule = 'streak' | 'spend' | 'eta' | 'holder';
export const REPLAY_RULES: readonly ReplayRule[] = Object.freeze(['streak', 'spend', 'eta', 'holder'] as const);

/** A journal line, its time parsed once. */
type Line = { t: number; event: string; phase?: number; sessionId?: string; data: Record<string, unknown> };

/** One stored run: its journal, and the two facts only its record holds. */
export type WeekRun = {
  slug: string;
  runId: string;
  lines: Line[];
  /** The run's failure-streak ceiling (`maxConsecutiveFailures`); the shipped 2 when the record says nothing. */
  maxFailures: number;
  /** Phases the record closed `done` over a verification that ran nothing — the audit's phase 9 (AUD-11). */
  unverifiedDone: { phase: number; at: number }[];
};

export type WeekReportOptions = {
  /** The console's name — a label, and the ETA back-test's pool key. */
  instance: string;
  since: string;
  /** Defaults to now. */
  until?: string;
  replay?: readonly ReplayRule[];
  /** A plan's phase sizes, for the ETA and holder models; null for a plan no longer on disk. */
  factsOf?: (slug: string) => PlanPhaseFacts | null;
  now?: number;
};

type Window = { since: number; until: number };
type Ender = 'person' | 'console' | 'wait-clock' | 'open';
type AvoidableCause = 'streak' | 'lint-crash' | 'credential-latch';
type StreakCause = 'rescued-command' | 'repeated-phase' | 'wait-budget';

export type RunDown = { slug: string; run: string; lifeHours: number; downHours: number; share: number };

export type WeekReport = {
  instance: string;
  since: string;
  until: string;
  replay: ReplayRule[];
  metrics: {
    /** WR-1 — the share of each run's working life it spent stopped, and what ended each stop. */
    down: { runs: RunDown[]; lifeHours: number; downHours: number; share: number; endedBy: Record<Ender, number> };
    /** WR-2 — down time opened by a stop today's rules would not make: nothing was learned before the press that ended it. */
    avoidable: { hours: number; byCause: Record<AvoidableCause, number> };
    /** WR-3 — failure-streak halts, and those that counted something other than distinct phases failed on their merits. */
    streakHalts: { total: number; flagged: number; byCause: Record<StreakCause, number> };
    /** WR-4 — verify-failed halts, and those whose own verification the verdict calls green. */
    verifyFailed: { halts: number; fromRescued: number };
    /** WR-5 — session spend booked against the CLI's own final total per session id. */
    spend: { sessions: number; bookedUsd: number; finalUsd: number; phantomUsd: number; phantomShare: number; mismatched: number };
    /** WR-6 + WR-8 — queue episodes: how much of the queued time was the run's own lane, and how much the journal recorded. */
    queue: { episodes: number; episodeHours: number; recordedHours: number; recordedShare: number; ownRunHours: number; ownRunShare: number; serialHours: number };
    /** WR-7 — the holder label a queue card showed against the wait that followed. */
    holderEta: { waits: number; medianRealisedOverLabel: number; errorAtMedian: number; medianLowOverRealised: number; lowCoverage: number; bandCoverage: number };
    /** WR-9 — phase ETA, scored the audit's way against the naive recent-median baseline. */
    phaseEta: { records: number; estimator: BacktestScore | null; baseline: BacktestScore; ships: boolean | null };
    /** WR-10 — stall cards raised on a lane whose phase had already finished. */
    stallsOnFinished: { count: number; bySignal: Record<string, number> };
    /** WR-11 — sessions that ended `max_turns`, and the resumes among them run under the closeout cap. */
    closeoutCapResumes: { maxTurnsEndings: number; underCloseoutCap: number };
    /** WR-12 — phases closed with an unrun §Verification. */
    unrunVerification: { count: number; phases: { slug: string; run: string; phase: number }[] };
    /** #91 — phases that ran on a model other than the one they named. */
    modelNamed: { starts: number; differs: number };
    /**
     * SIZ-6 — what re-reading the context cost: the cache-read volume, the mean
     * context each call re-read, and the boot prefix's share of it (every call
     * after the first re-reads the context the session booted with). Only
     * sessions whose `phase.tokens` carries `firstContext` (phase 59) measure the
     * share; `bootMeasured` says how many did.
     */
    context: { sessions: number; calls: number; cacheReadMTokens: number; meanContextK: number; bootShare: number | null; bootMeasured: number };
  };
  /** §End-to-end verification item 10, judged on these numbers. `met: null` — nothing to judge. */
  targets: { id: string; target: string; value: string; met: boolean | null }[];
};

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

function readJson(path: string): Record<string, unknown> | null {
  try { return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>; } catch { return null; }
}

function readLines(path: string): Line[] {
  const out: Line[] = [];
  let text = '';
  try { text = readFileSync(path, 'utf8'); } catch { return out; }
  for (const raw of text.split('\n')) {
    if (!raw) continue;
    let entry: { time?: unknown; event?: unknown; phase?: unknown; sessionId?: unknown; data?: unknown };
    try { entry = JSON.parse(raw); } catch { continue; /* a half-written tail */ }
    const t = typeof entry.time === 'string' ? Date.parse(entry.time) : NaN;
    if (!Number.isFinite(t) || typeof entry.event !== 'string') continue;
    out.push({
      t,
      event: entry.event,
      ...(typeof entry.phase === 'number' ? { phase: entry.phase } : {}),
      ...(typeof entry.sessionId === 'string' ? { sessionId: entry.sessionId } : {}),
      data: entry.data && typeof entry.data === 'object' ? entry.data as Record<string, unknown> : {},
    });
  }
  return out;
}

/** The record's own word that a verification ran nothing: the stop's sentence, or no command run and some not. */
const STOPPED_VERIFICATION = /stopped mid-verification/i;

function unverifiedOf(record: Record<string, unknown> | null): WeekRun['unverifiedDone'] {
  const out: WeekRun['unverifiedDone'] = [];
  const phases = record?.phases && typeof record.phases === 'object' ? Object.values(record.phases as Record<string, unknown>) : [];
  for (const value of phases) {
    const phase = value as { phase?: unknown; status?: unknown; endedAt?: unknown; verification?: { reason?: unknown; ran?: unknown; notRun?: unknown } } | null;
    if (!phase || phase.status !== 'done' || typeof phase.phase !== 'number') continue;
    const verification = phase.verification;
    if (!verification) continue;
    const ranNothing = Array.isArray(verification.notRun) && verification.notRun.length > 0
      && !(Array.isArray(verification.ran) && verification.ran.length > 0);
    if (!STOPPED_VERIFICATION.test(String(verification.reason ?? '')) && !ranNothing) continue;
    const at = typeof phase.endedAt === 'string' ? Date.parse(phase.endedAt) : NaN;
    if (Number.isFinite(at)) out.push({ phase: phase.phase, at });
  }
  return out;
}

/** Every stored run under a console's `runs/<instance>` directory — read-only. */
export function readRuns(runsDir: string): WeekRun[] {
  const runs: WeekRun[] = [];
  if (!existsSync(runsDir)) return runs;
  for (const slug of readdirSync(runsDir).sort()) {
    const dir = join(runsDir, slug);
    try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
    for (const file of readdirSync(dir).sort()) {
      const match = /^run-([0-9a-z]+)\.jsonl$/.exec(file);
      if (!match) continue;
      const record = readJson(join(dir, `run-${match[1]}.json`));
      const max = Number(record?.maxConsecutiveFailures);
      runs.push({
        slug,
        runId: match[1]!,
        lines: readLines(join(dir, file)),
        maxFailures: Number.isInteger(max) && max > 0 ? max : 2,
        unverifiedDone: unverifiedOf(record),
      });
    }
  }
  return runs;
}

/** A plan's phase facts from `<docsRoot>/docs/plans/<slug>.md`, sized by `scripts/sizing.env` — read once per plan. */
export function planFactsReader(docsRoot: string, scriptsDir: string): (slug: string) => PlanPhaseFacts | null {
  const { S, M, L } = loadSizing(scriptsDir);
  const cache = new Map<string, PlanPhaseFacts | null>();
  return (slug) => {
    if (!cache.has(slug)) {
      const path = join(docsRoot, 'docs', 'plans', `${slug}.md`);
      cache.set(slug, existsSync(path) ? planFacts(readFileSync(path, 'utf8'), slug, { S, M, L }) : null);
    }
    return cache.get(slug) ?? null;
  };
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const hours = (ms: number): number => Math.round(ms / 36_000) / 100;
const share = (part: number, whole: number): number => (whole > 0 ? Math.round((part / whole) * 1000) / 1000 : 0);
const usd = (value: number): number => Math.round(value * 100) / 100;
const round2 = (value: number): number => Math.round(value * 100) / 100;
const inWindow = (w: Window, t: number): boolean => t >= w.since && t < w.until;

function median(list: readonly number[]): number {
  if (!list.length) return 0;
  const sorted = [...list].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** How much of [a, b] the (possibly overlapping) windows cover. */
function covered(windows: readonly (readonly [number, number])[], a: number, b: number): number {
  const clipped = windows
    .map(([from, to]) => [Math.max(from, a), Math.min(to, b)] as const)
    .filter(([from, to]) => to > from)
    .sort((x, y) => x[0] - y[0]);
  let total = 0;
  let end = -Infinity;
  for (const [from, to] of clipped) {
    if (to <= end) continue;
    total += to - Math.max(from, end);
    end = to;
  }
  return total;
}

function sessionWindows(run: WeekRun): [number, number][] {
  const out: [number, number][] = [];
  for (const line of run.lines) {
    const ms = num(line.data.ms);
    if (line.event === 'phase.session' && ms && ms > 0) out.push([line.t - ms, line.t]);
  }
  return out;
}

/** What ends a declared wait (`phase.waiting`) for its phase. */
const WAIT_ENDS = new Set(['phase.wait-resume', 'phase.wait-settled', 'phase.start', 'phase.outcome', 'phase.done']);

/**
 * The time a run was doing something other than standing stopped: a session,
 * a verification, a queue episode or a declared wait. The audit's order —
 * session, verify, queued, wait, then down — so none of it is down time.
 */
function busyWindows(run: WeekRun, episodes: readonly Episode[]): [number, number][] {
  const out = sessionWindows(run);
  const waiting = new Map<number, number>();
  for (const line of run.lines) {
    if (line.phase === undefined) continue;
    if (line.event === 'phase.verify') {
      const ms = (Array.isArray(line.data.ran) ? line.data.ran as { ms?: unknown }[] : []).reduce((sum, row) => sum + (num(row?.ms) ?? 0), 0);
      if (ms > 0) out.push([line.t - ms, line.t]);
    } else if (line.event === 'phase.waiting') {
      if (!waiting.has(line.phase)) waiting.set(line.phase, line.t);
    } else if (WAIT_ENDS.has(line.event) && waiting.has(line.phase)) {
      out.push([waiting.get(line.phase)!, line.t]);
      waiting.delete(line.phase);
    }
  }
  for (const from of waiting.values()) out.push([from, Infinity]);
  for (const episode of episodes) out.push([episode.open, episode.close ?? Infinity]);
  return out;
}

/* ------------------------------------------------------------------ *
 * The failure streak (WR-3, WR-4; replay rule `streak`)
 * ------------------------------------------------------------------ */

/** What each `phase.halted` kind charges under today's rule (phase 45); a kind not named charges nothing. */
const CAUSE_OF_HALT: Readonly<Record<string, string>> = Object.freeze({
  'verify-failed': 'verify-red',
  'no-handoff': 'no-handoff',
  'phase-blocked': 'declared-blocked',
  'phase-crashed': 'crash',
});

/** A spent wait budget — a park since phase 45, a charged failure before it. */
const WAIT_BUDGET_HALT = 'waiting-external-timeout';

/**
 * A verification's rows as the verdict reads them. A row written before
 * phase 45 carries `code` and no `retry`: its runner retried a red command
 * once, as the next row, so that row is marked the retry it was.
 */
function verifyRows(ran: unknown): VerifyRun[] {
  const rows = Array.isArray(ran) ? (ran as unknown[]).filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object') : [];
  const marked = rows.some((row) => 'retry' in row);
  const out: VerifyRun[] = [];
  rows.forEach((row, index) => {
    const prior = out[index - 1];
    const retry = marked ? row.retry === true : prior !== undefined && !prior.retry && prior.command === String(row.command ?? '');
    out.push({ ...row, command: String(row.command ?? ''), ok: typeof row.ok === 'boolean' ? row.ok : row.code === 0, retry } as unknown as VerifyRun);
  });
  return out;
}

/** Did a verification go green only through a retry — the verdict's `rescued`, and nothing `broke`? */
function rescuedOnly(ran: unknown): boolean {
  const rows = verifyRows(ran);
  if (!rows.length) return false;
  const verdict = verificationVerdict(rows);
  return verdict.broke.length === 0 && verdict.timedOut.length === 0 && verdict.rescued.length > 0;
}

type StreakWalk = {
  /** Each recorded failure-streak halt: its causes, and whether today's rule would have reached the ceiling. */
  halts: { at: number; causes: StreakCause[]; avoidable: boolean }[];
  /** When today's rule halts, over the same endings. */
  replayed: number[];
  verifyFailed: { at: number; rescued: boolean }[];
};

function walkStreak(run: WeekRun): StreakWalk {
  const walk: StreakWalk = { halts: [], replayed: [], verifyFailed: [] };
  const rescued = new Map<number, boolean>();
  /** Every failed ending since the last reset — what the old counter counted. */
  let ended: { phase: number; kind: string; rescued: boolean }[] = [];
  /** Today's counter: distinct phases, merit causes only. */
  let charged: number[] = [];
  const merit = (kind: string, wasRescued: boolean): boolean => {
    const cause = CAUSE_OF_HALT[kind];
    return !wasRescued && cause !== undefined && isMeritFailure(cause);
  };
  for (const line of run.lines) {
    if (line.event === 'phase.verify' && line.phase !== undefined) {
      rescued.set(line.phase, rescuedOnly(line.data.ran));
    } else if (line.event === 'phase.done' || line.event === 'run.failure-streak-reset') {
      ended = [];
      charged = [];
    } else if (line.event === 'phase.halted' && line.phase !== undefined) {
      const kind = String(line.data.kind ?? '');
      const wasRescued = kind === 'verify-failed' && rescued.get(line.phase) === true;
      if (kind === 'verify-failed') walk.verifyFailed.push({ at: line.t, rescued: wasRescued });
      ended.push({ phase: line.phase, kind, rescued: wasRescued });
      if (merit(kind, wasRescued) && !charged.includes(line.phase)) {
        charged.push(line.phase);
        // Today's run halts here, and a person's press starts it counting afresh.
        if (charged.length >= run.maxFailures) { walk.replayed.push(line.t); charged = []; }
      }
    } else if (line.event === 'run.halt' && line.data.kind === 'failure-streak') {
      const claimed = Number(/(\d+) phases? failed in a row/.exec(String(line.data.reason ?? ''))?.[1] ?? run.maxFailures);
      const tail = ended.slice(-Math.max(1, claimed));
      const causes: StreakCause[] = [];
      if (tail.some((entry) => entry.rescued)) causes.push('rescued-command');
      if (tail.some((entry) => entry.kind === WAIT_BUDGET_HALT)) causes.push('wait-budget');
      if (new Set(tail.map((entry) => entry.phase)).size < tail.length) causes.push('repeated-phase');
      const distinctMerit = new Set(tail.filter((entry) => merit(entry.kind, entry.rescued)).map((entry) => entry.phase));
      walk.halts.push({ at: line.t, causes, avoidable: distinctMerit.size < run.maxFailures });
    }
  }
  return walk;
}

/* ------------------------------------------------------------------ *
 * Down time (WR-1, WR-2)
 * ------------------------------------------------------------------ */

/** Events that stop a run, and the two that start it again. */
const STOPS = new Set(['run.halt', 'run.parked', 'run.paused', 'run.stop-requested', 'run.console-shutdown', 'run.frozen', 'run.finished']);
const RESTARTS = new Set(['run.start', 'run.limit-resume']);
/** Events that prove a run was working — its life is the span between the first and the last in the window. */
const WORK = new Set(['run.start', 'phase.start', 'phase.session', 'phase.verify', 'phase.done', 'phase.admitted']);
/** Who, besides a person, starts a run — an older `run.start` names its starter in `by` and has no door. */
const AUTOMATIC_STARTERS = new Set(['console', 'converge', 'heal', 'script', 'unsupervised', 'watch']);
/** A Start pressed on a card reaches the run through the converge loop within a few seconds. */
const PRESS_WINDOW_MS = 5_000;

function enderOf(run: WeekRun, index: number): Ender {
  const line = run.lines[index]!;
  if (line.event === 'run.limit-resume') return 'wait-clock';
  if (line.data.door === OPERATOR_DOOR) return 'person';
  for (let i = index - 1; i >= 0 && line.t - run.lines[i]!.t <= PRESS_WINDOW_MS; i -= 1) {
    const prior = run.lines[i]!;
    if (prior.event === 'run.converge' && prior.data.trigger === 'button') return 'person';
  }
  const by = typeof line.data.by === 'string' ? line.data.by : '';
  return line.data.door === undefined && by !== '' && !AUTOMATIC_STARTERS.has(by) ? 'person' : 'console';
}

function lifeOf(run: WeekRun, w: Window): [number, number] | null {
  let first = Infinity;
  let last = -Infinity;
  for (const line of run.lines) {
    if (!WORK.has(line.event)) continue;
    const ms = line.event === 'phase.session' ? num(line.data.ms) ?? 0 : 0;
    for (const t of [line.t - ms, line.t]) {
      if (!inWindow(w, t)) continue;
      first = Math.min(first, t);
      last = Math.max(last, t);
    }
  }
  return first < last ? [first, last] : null;
}

type Segment = { from: number; to: number; opener: Line; ender: Ender };

/** Each stretch a run spent stopped, split where a halt re-labels it, each piece carrying the press that ended the stretch. */
function downSegments(run: WeekRun): Segment[] {
  const out: Segment[] = [];
  let open: Segment[] = [];
  const settle = (to: number, ender: Ender): void => {
    open.forEach((segment, i) => { segment.to = open[i + 1]?.from ?? to; segment.ender = ender; });
    out.push(...open);
    open = [];
  };
  run.lines.forEach((line, index) => {
    if (STOPS.has(line.event)) {
      if (!open.length || line.event === 'run.halt') open.push({ from: line.t, to: Infinity, opener: line, ender: 'open' });
    } else if (open.length && RESTARTS.has(line.event)) {
      settle(line.t, enderOf(run, index));
    }
  });
  if (open.length) settle(Infinity, 'open');
  return out;
}

/**
 * The older console's sentence for an outage it read as a refused credential
 * (AUD-1's credential latch, fixed by phase 3). `isTransportFailure` reads the
 * CLI's own words; a halt's reason is the console's paraphrase of them.
 */
const OUTAGE_SENTENCE = /refused the connection|could not reach the API|certificate this machine does not trust|connection (?:error|refused|reset)/i;

/** Why a stop was avoidable under today's rules, and from when; null when it was not. */
function avoidableOf(opener: Line, spurious: ReadonlySet<number>, apiAnswers: readonly number[]): { cause: AvoidableCause; from: number } | null {
  if (opener.event !== 'run.halt') return null;
  const reason = String(opener.data.reason ?? '');
  switch (opener.data.kind) {
    case 'failure-streak':
      return spurious.has(opener.t) ? { cause: 'streak', from: opener.t } : null;
    case 'plan-lint':
      // "left the plan failing validate.sh: " and nothing after it — a lint that proved nothing (phase 4).
      return /validate\.sh:\s*$/.test(reason) ? { cause: 'lint-crash', from: opener.t } : null;
    case 'credential-refused': {
      // An outage read as a refused credential (phase 3): avoidable from the moment the API answered again.
      if (!isTransportFailure(reason) && !OUTAGE_SENTENCE.test(reason)) return null;
      const back = apiAnswers.find((t) => t > opener.t);
      return back === undefined ? null : { cause: 'credential-latch', from: back };
    }
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ *
 * The queue (WR-6, WR-7, WR-8; replay rule `holder`)
 * ------------------------------------------------------------------ */

type Episode = {
  phase: number;
  open: number;
  close: number | null;
  admitted: boolean;
  closedBy: string;
  /** The wait the journal wrote down for it, when it wrote one. */
  recorded: number | null;
  /** The head holder, from each `phase.queued` naming one: from when, whether it is the run's own lane, the card's label. */
  heads: { from: number; own: boolean; label: string | null }[];
};

function queueEpisodes(run: WeekRun): Episode[] {
  const out: Episode[] = [];
  const open = new Map<number, Episode>();
  const lastClosed = new Map<number, Episode>();
  const ownOwner = `autopilot/${run.runId}`;
  const close = (episode: Episode, t: number, by: string, recorded: number | null, admitted: boolean): void => {
    Object.assign(episode, { close: t, closedBy: by, recorded, admitted });
    open.delete(episode.phase);
    lastClosed.set(episode.phase, episode);
  };
  for (const line of run.lines) {
    if (line.phase === undefined) {
      // A run-level withdrawal or a console shutdown ends every open wait, recording none.
      if (line.event.endsWith('-withdrew') || line.event === 'run.console-shutdown') {
        for (const episode of [...open.values()]) close(episode, line.t, line.event, null, false);
      }
      continue;
    }
    const episode = open.get(line.phase);
    switch (line.event) {
      case 'phase.queued': {
        const head = (line.data.waitingOn as { phase?: unknown; owner?: unknown; eta?: { label?: unknown } }[] | undefined)?.[0];
        const entry = {
          from: line.t,
          own: head?.owner === ownOwner && typeof head.phase === 'number',
          label: typeof head?.eta?.label === 'string' ? head.eta.label : null,
        };
        if (episode) episode.heads.push(entry);
        else {
          const fresh: Episode = { phase: line.phase, open: line.t, close: null, admitted: false, closedBy: '', recorded: null, heads: [entry] };
          open.set(line.phase, fresh);
          out.push(fresh);
        }
        break;
      }
      case 'phase.admitted':
        if (episode) close(episode, line.t, line.event, num(line.data.waitedMs), true);
        break;
      case 'phase.queue-closed': {
        const recorded = num(line.data.waitedMs) ?? num(line.data.ms);
        if (episode) close(episode, line.t, line.event, recorded, line.data.outcome === 'admitted');
        else {
          // Written beside `phase.admitted` for the same wait: the same episode, not a second one.
          const last = lastClosed.get(line.phase);
          if (last && last.close !== null && line.t - last.close <= PRESS_WINDOW_MS && recorded !== null) last.recorded = recorded;
        }
        break;
      }
      case 'phase.not-started':
      case 'phase.lock-wait-capped':
        if (episode) close(episode, line.t, line.event, null, false);
        break;
      case 'phase.start':
        // Boarded with no admission line: the wait happened and nothing recorded it.
        if (episode) close(episode, line.t, line.event, null, true);
        break;
      default:
        break;
    }
  }
  return out;
}

/** "~1.5 d–3.3 d left", "~40 min–1.5 h of work left" → the band, in ms. */
const LABEL_UNIT_MS: Readonly<Record<string, number>> = Object.freeze({ s: 1_000, m: 60_000, min: 60_000, h: 3_600_000, d: 86_400_000 });

function parseLabel(label: string): { low: number; high: number } | null {
  const spans = [...label.matchAll(/(\d+(?:\.\d+)?)\s*(min|m|h|d|s)\b/g)].map((match) => Number(match[1]) * LABEL_UNIT_MS[match[2]!]!);
  return spans.length ? { low: Math.min(...spans), high: Math.max(...spans) } : null;
}

type LabelledWait = { realised: number; point: number; low: number; high: number };

function holderScore(waits: readonly LabelledWait[]): WeekReport['metrics']['holderEta'] {
  const kept = waits.filter((wait) => wait.realised > 0 && wait.point > 0);
  const m = median(kept.map((wait) => wait.realised / wait.point));
  return {
    waits: kept.length,
    medianRealisedOverLabel: round2(m),
    errorAtMedian: kept.length ? round2(m >= 1 ? m : 1 / m) : 0,
    medianLowOverRealised: round2(median(kept.map((wait) => wait.low / wait.realised))),
    lowCoverage: share(kept.filter((wait) => wait.low <= wait.realised).length, kept.length),
    bandCoverage: share(kept.filter((wait) => wait.low <= wait.realised && wait.realised <= wait.high).length, kept.length),
  };
}

/* ------------------------------------------------------------------ *
 * The report
 * ------------------------------------------------------------------ */

/**
 * The report over runs already read. `records` (every measured phase, all
 * time) and `waits` (every admitted wait, holder model inputs) are what the
 * `eta` and `holder` rules replay; `weekReportFromDir` reads all three.
 */
export function weekReport(
  input: { runs: readonly WeekRun[]; records?: readonly BacktestRecord[]; waits?: readonly HolderWait[] },
  options: WeekReportOptions,
): WeekReport {
  const w: Window = { since: Date.parse(options.since), until: options.until ? Date.parse(options.until) : options.now ?? Date.now() };
  if (!Number.isFinite(w.since) || !Number.isFinite(w.until) || w.until <= w.since) {
    throw new Error(`the window must be two instants, --since before --until (got ${options.since} → ${options.until ?? 'now'})`);
  }
  const replay = new Set(options.replay ?? []);
  const { runs } = input;

  // When the API answered, anywhere on this console: a usage reading or a session that ended well.
  const apiAnswers = runs
    .flatMap((run) => run.lines.filter((line) => line.event === 'run.usage-window' || (line.event === 'phase.session' && line.data.isError === false)))
    .map((line) => line.t)
    .sort((a, b) => a - b);

  // WR-1..4 — per run, then summed.
  const endedBy: Record<Ender, number> = { person: 0, console: 0, 'wait-clock': 0, open: 0 };
  const avoidable: Record<AvoidableCause, number> = { streak: 0, 'lint-crash': 0, 'credential-latch': 0 };
  const streakHalts = { total: 0, flagged: 0, byCause: { 'rescued-command': 0, 'repeated-phase': 0, 'wait-budget': 0 } as Record<StreakCause, number> };
  const verifyFailed = { halts: 0, fromRescued: 0 };
  const downRuns: RunDown[] = [];
  let lifeMs = 0;
  let downMs = 0;
  for (const run of runs) {
    const walk = walkStreak(run);
    const halts = walk.halts.filter((halt) => inWindow(w, halt.at));
    const spurious = new Set(walk.halts.filter((halt) => halt.avoidable).map((halt) => halt.at));
    if (replay.has('streak')) {
      streakHalts.total += walk.replayed.filter((t) => inWindow(w, t)).length;
      verifyFailed.halts += walk.verifyFailed.filter((halt) => inWindow(w, halt.at) && !halt.rescued).length;
    } else {
      streakHalts.total += halts.length;
      for (const halt of halts) {
        if (halt.causes.length) streakHalts.flagged += 1;
        for (const cause of halt.causes) streakHalts.byCause[cause] += 1;
      }
      const failed = walk.verifyFailed.filter((halt) => inWindow(w, halt.at));
      verifyFailed.halts += failed.length;
      verifyFailed.fromRescued += failed.filter((halt) => halt.rescued).length;
    }

    const life = lifeOf(run, w);
    if (!life) continue;
    const sessions = busyWindows(run, queueEpisodes(run));
    let runDown = 0;
    for (const segment of downSegments(run)) {
      const a = Math.max(segment.from, life[0]);
      const b = Math.min(segment.to, life[1]);
      if (b <= a) continue;
      const why = avoidableOf(segment.opener, spurious, apiAnswers);
      // Today's streak rule never makes this stop at all.
      if (why?.cause === 'streak' && replay.has('streak')) continue;
      const net = b - a - covered(sessions, a, b);
      runDown += net;
      endedBy[segment.ender] += net;
      if (why) {
        const from = Math.max(a, why.from);
        if (b > from) avoidable[why.cause] += b - from - covered(sessions, from, b);
      }
    }
    lifeMs += life[1] - life[0];
    downMs += runDown;
    downRuns.push({ slug: run.slug, run: run.runId, lifeHours: hours(life[1] - life[0]), downHours: hours(runDown), share: share(runDown, life[1] - life[0]) });
  }

  // WR-5 — spend. The truth per session id is the CLI's own running total,
  // folded across every run that booked it; `booked` is what was written down
  // then, or — under the `spend` rule — what today's per-record mark books.
  const truthMark = new Map<string, number>();
  const replayMark = new Map<string, number>();
  const perSession = new Map<string, { booked: number; final: number }>();
  const sessionLines = runs
    .flatMap((run) => run.lines.filter((line) => line.event === 'phase.session').map((line) => ({ run, line })))
    .sort((a, b) => a.line.t - b.line.t);
  for (const { run, line } of sessionLines) {
    const id = String(line.data.sessionId ?? line.sessionId ?? '');
    const total = num(line.data.costUsd);
    if (!id || total === null) continue;
    const known = line.data.costSource !== 'none';
    const truth = bookedDelta(truthMark.get(id), total, known);
    truthMark.set(id, truth.mark);
    const key = `${run.slug}/${run.runId}/${line.phase ?? ''}/${id}`;
    const today = bookedDelta(replayMark.get(key), total, known);
    replayMark.set(key, today.mark);
    if (!inWindow(w, line.t)) continue;
    const booked = replay.has('spend') ? today.booked : num(line.data.bookedUsd) ?? total;
    const entry = perSession.get(id) ?? { booked: 0, final: 0 };
    entry.booked += booked;
    entry.final += truth.booked;
    perSession.set(id, entry);
  }
  let bookedUsd = 0;
  let finalUsd = 0;
  let mismatched = 0;
  for (const { booked, final } of perSession.values()) {
    bookedUsd += booked;
    finalUsd += final;
    if (Math.abs(booked - final) > 0.01) mismatched += 1;
  }

  // WR-6, WR-7, WR-8 — the queue.
  let episodes = 0;
  let episodeMs = 0;
  let recordedMs = 0;
  let ownMs = 0;
  const labelled: LabelledWait[] = [];
  for (const run of runs) {
    for (const episode of queueEpisodes(run)) {
      if (!inWindow(w, episode.open)) continue;
      const end = Math.min(episode.close ?? w.until, w.until);
      let own = 0;
      episode.heads.forEach((head, i) => {
        const to = Math.min(episode.heads[i + 1]?.from ?? end, end);
        if (head.own && to > head.from) own += to - head.from;
      });
      const span = end - episode.open;
      if (replay.has('holder')) {
        // Today's scheduler: a wait behind the run's own lane is serial and never queues;
        // every other episode closes with its wait written down.
        if (span - own > 0) { episodes += 1; episodeMs += span - own; recordedMs += span - own; }
        ownMs += own;
        continue;
      }
      episodes += 1;
      episodeMs += span;
      ownMs += own;
      if (episode.close !== null && episode.close <= w.until && episode.recorded !== null) recordedMs += episode.recorded;
      const band = episode.admitted && episode.heads[0]?.label ? parseLabel(episode.heads[0].label) : null;
      if (band && episode.close !== null) {
        labelled.push({ realised: episode.recorded ?? episode.close - episode.open, point: Math.sqrt(band.low * band.high), ...band });
      }
    }
  }
  const holderEta = replay.has('holder')
    ? holderScore((input.waits ?? []).filter((wait) => inWindow(w, Date.parse(wait.queuedAt))).map((wait) => {
      const label = holderRemaining(wait.estimateMs, wait.spread, wait.workedMs);
      return { realised: wait.waitedMs, point: label.remainingMs, low: label.lowMs, high: label.highMs };
    }))
    : holderScore(labelled);

  // WR-9 — phase ETA: each phase that began in the window, predicted at its
  // first boarding from the same console's phases that had ended by then.
  const records = input.records ?? [];
  const ended = [...records].sort((a, b) => a.endedAt.localeCompare(b.endedAt));
  const model: [number, number][] = [];
  const naive: [number, number][] = [];
  for (const target of records) {
    if (!inWindow(w, Date.parse(target.startedAt))) continue;
    const prior = ended.filter((r) => r.instance === target.instance && r.endedAt < target.startedAt);
    naive.push([target.workedMs, baselineEstimate(prior, target)]);
    if (replay.has('eta')) model.push([target.workedMs, modelEstimate(prior, target)]);
  }
  const baseline = scorePairs(naive);
  const estimator = replay.has('eta') ? scorePairs(model) : null;

  // WR-10, WR-11, WR-12, #91 — counted off the journal as it stands.
  const stallsOnFinished = { count: 0, bySignal: {} as Record<string, number> };
  const closeoutCapResumes = { maxTurnsEndings: 0, underCloseoutCap: 0 };
  const unrun = new Map<string, { slug: string; run: string; phase: number }>();
  const modelNamed = { starts: 0, differs: 0 };
  for (const run of runs) {
    const doneAt = new Map<number, number>();
    const stopped = new Set<number>();
    for (const line of run.lines) {
      const p = line.phase;
      const counted = inWindow(w, line.t);
      if (line.event === 'phase.start' && p !== undefined) {
        doneAt.delete(p);
        stopped.delete(p);
        if (counted) modelNamed.starts += 1;
      } else if (line.event === 'phase.model-differs' && counted) {
        modelNamed.differs += 1;
      } else if (line.event === 'phase.verify' && p !== undefined) {
        stopped.delete(p);
      } else if (line.event === 'phase.verify-stopped' && p !== undefined) {
        stopped.add(p);
      } else if ((line.event === 'phase.done' || (line.event === 'phase.reconciled' && line.data.outcome === 'done')) && p !== undefined) {
        doneAt.set(p, line.t);
        if (counted && stopped.has(p)) unrun.set(`${run.slug}/${run.runId}/${p}`, { slug: run.slug, run: run.runId, phase: p });
      } else if (line.event === 'phase.stall' && p !== undefined && counted && doneAt.has(p)) {
        const signal = String(line.data.signal ?? 'unknown');
        stallsOnFinished.count += 1;
        stallsOnFinished.bySignal[signal] = (stallsOnFinished.bySignal[signal] ?? 0) + 1;
      } else if (line.event === 'phase.session' && counted && (line.data.terminalReason === 'max_turns' || line.data.subtype === 'error_max_turns')) {
        closeoutCapResumes.maxTurnsEndings += 1;
        const cap = line.data.maxTurns as { source?: unknown } | undefined;
        if (cap?.source === 'closeout' && line.data.mode !== 'closeout') closeoutCapResumes.underCloseoutCap += 1;
      }
    }
    for (const { phase, at } of run.unverifiedDone) {
      if (inWindow(w, at)) unrun.set(`${run.slug}/${run.runId}/${phase}`, { slug: run.slug, run: run.runId, phase });
    }
  }

  // SIZ-6 — context × calls, from each session's `phase.tokens`.
  const context = { sessions: 0, calls: 0, cacheRead: 0, bootRead: 0, bootBase: 0, bootMeasured: 0 };
  for (const run of runs) {
    for (const line of run.lines) {
      if (line.event !== 'phase.tokens' || !inWindow(w, line.t)) continue;
      const calls = num(line.data.calls);
      const read = num(line.data.cacheRead);
      if (!calls || read === null) continue;
      context.sessions += 1;
      context.calls += calls;
      context.cacheRead += read;
      const first = num(line.data.firstContext);
      if (first === null || read <= 0) continue;
      context.bootMeasured += 1;
      context.bootRead += Math.min(first * Math.max(0, calls - 1), read);
      context.bootBase += read;
    }
  }

  const metrics: WeekReport['metrics'] = {
    down: {
      runs: downRuns,
      lifeHours: hours(lifeMs),
      downHours: hours(downMs),
      share: share(downMs, lifeMs),
      endedBy: { person: hours(endedBy.person), console: hours(endedBy.console), 'wait-clock': hours(endedBy['wait-clock']), open: hours(endedBy.open) },
    },
    avoidable: {
      hours: hours(avoidable.streak + avoidable['lint-crash'] + avoidable['credential-latch']),
      byCause: { streak: hours(avoidable.streak), 'lint-crash': hours(avoidable['lint-crash']), 'credential-latch': hours(avoidable['credential-latch']) },
    },
    streakHalts,
    verifyFailed,
    spend: {
      sessions: perSession.size,
      bookedUsd: usd(bookedUsd),
      finalUsd: usd(finalUsd),
      phantomUsd: usd(bookedUsd - finalUsd),
      phantomShare: share(bookedUsd - finalUsd, bookedUsd),
      mismatched,
    },
    queue: {
      episodes,
      episodeHours: hours(episodeMs),
      recordedHours: hours(recordedMs),
      recordedShare: share(recordedMs, episodeMs),
      ownRunHours: replay.has('holder') ? 0 : hours(ownMs),
      ownRunShare: replay.has('holder') ? 0 : share(ownMs, episodeMs),
      serialHours: replay.has('holder') ? hours(ownMs) : 0,
    },
    holderEta,
    phaseEta: {
      records: naive.length,
      estimator,
      baseline,
      ships: estimator ? estimator.within2 >= baseline.within2 && estimator.male <= baseline.male : null,
    },
    stallsOnFinished,
    closeoutCapResumes,
    unrunVerification: { count: unrun.size, phases: [...unrun.values()] },
    modelNamed,
    context: {
      sessions: context.sessions,
      calls: context.calls,
      cacheReadMTokens: round2(context.cacheRead / 1e6),
      meanContextK: context.calls ? Math.round(context.cacheRead / context.calls / 1000) : 0,
      bootShare: context.bootBase ? share(context.bootRead, context.bootBase) : null,
      bootMeasured: context.bootMeasured,
    },
  };
  return {
    instance: options.instance,
    since: new Date(w.since).toISOString(),
    until: new Date(w.until).toISOString(),
    replay: REPLAY_RULES.filter((rule) => replay.has(rule)),
    metrics,
    targets: targetsOf(metrics, Math.abs(recordedMs - episodeMs) <= 1_000 * Math.max(episodes, 1)),
  };
}

/** §End-to-end verification item 10's targets, judged on the numbers above. */
function targetsOf(m: WeekReport['metrics'], queueBalanced: boolean): WeekReport['targets'] {
  const holderMet = m.holderEta.waits ? m.holderEta.errorAtMedian <= 2 && m.holderEta.lowCoverage >= 0.5 : null;
  return [
    {
      id: 'streak', target: 'no streak halt from a rescued command, a repeated ending of one phase or a wait-budget refusal',
      value: `${m.streakHalts.flagged} of ${m.streakHalts.total} halts; ${m.verifyFailed.fromRescued} verify-failed from a rescued command`,
      met: m.streakHalts.flagged === 0 && m.verifyFailed.fromRescued === 0,
    },
    {
      id: 'phantom', target: 'booked per session id = the CLI\'s final total, within $0.01',
      value: `${m.spend.mismatched} of ${m.spend.sessions} sessions differ; phantom $${m.spend.phantomUsd} (${Math.round(m.spend.phantomShare * 1000) / 10} %)`,
      met: m.spend.mismatched === 0,
    },
    {
      id: 'holder-eta', target: 'holder ETA within 2x at the median, low bound at or under the wait in half the cases',
      value: `${m.holderEta.errorAtMedian}x at the median, low bound held in ${Math.round(m.holderEta.lowCoverage * 100)} % of ${m.holderEta.waits}`,
      met: holderMet,
    },
    {
      id: 'own-run', target: 'no own-run lane wait reported as contention',
      value: `${Math.round(m.queue.ownRunShare * 1000) / 10} % of queued time (${m.queue.ownRunHours} h)`,
      met: m.queue.ownRunHours === 0,
    },
    {
      id: 'queue-recorded', target: 'recorded queue time = the queue episodes',
      value: `${m.queue.recordedHours} h recorded of ${m.queue.episodeHours} h over ${m.queue.episodes} episodes`,
      met: m.queue.episodes ? queueBalanced : null,
    },
    {
      id: 'phase-eta', target: 'phase ETA: within-2x share at or above the naive baseline, MALE at or below it',
      value: m.phaseEta.estimator
        ? `within 2x ${Math.round(m.phaseEta.estimator.within2 * 100)} % vs ${Math.round(m.phaseEta.baseline.within2 * 100)} %, MALE ${round2(m.phaseEta.estimator.male)} vs ${round2(m.phaseEta.baseline.male)} (${m.phaseEta.records} phases)`
        : `not journalled; the baseline scores within 2x ${Math.round(m.phaseEta.baseline.within2 * 100)} %, MALE ${round2(m.phaseEta.baseline.male)} — pass --replay`,
      met: m.phaseEta.estimator && m.phaseEta.records ? m.phaseEta.ships : null,
    },
    { id: 'avoidable', target: 'no avoidable down time with no new information', value: `${m.avoidable.hours} h`, met: m.avoidable.hours === 0 },
    { id: 'unrun-verification', target: 'no phase closed with an unrun verification', value: String(m.unrunVerification.count), met: m.unrunVerification.count === 0 },
    { id: 'stall-finished', target: 'no stall card on a finished lane', value: String(m.stallsOnFinished.count), met: m.stallsOnFinished.count === 0 },
    { id: 'closeout-cap', target: 'no resume ending max_turns under the closeout cap', value: `${m.closeoutCapResumes.underCloseoutCap} of ${m.closeoutCapResumes.maxTurnsEndings} max_turns endings`, met: m.closeoutCapResumes.underCloseoutCap === 0 },
    { id: 'model', target: 'every phase ran on the model it named', value: `${m.modelNamed.differs} of ${m.modelNamed.starts} starts differ`, met: m.modelNamed.differs === 0 },
  ];
}

/** Read a console's `runs/<instance>` directory and report on it. Read-only. */
export function weekReportFromDir(runsDir: string, options: WeekReportOptions): WeekReport {
  const factsOf = options.factsOf ?? ((): PlanPhaseFacts | null => null);
  const replay = new Set(options.replay ?? []);
  return weekReport({
    runs: readRuns(runsDir),
    records: recordsFromRuns(runsDir, options.instance, factsOf).records,
    waits: replay.has('holder') ? holderWaitsFromRuns(runsDir, options.instance, factsOf) : [],
  }, options);
}

/** The report for a person: one line per measurement, then the targets. */
export function formatWeekReport(report: WeekReport): string {
  const m = report.metrics;
  const pct = (value: number): string => `${Math.round(value * 1000) / 10} %`;
  const rows: [string, string][] = [
    ['Down share', `${pct(m.down.share)} of ${m.down.lifeHours} run-hours; ended by a person ${m.down.endedBy.person} h, by the console ${m.down.endedBy.console} h, by a wait clock ${m.down.endedBy['wait-clock']} h, still down ${m.down.endedBy.open} h`],
    ['Avoidable down', `${m.avoidable.hours} h: failure streaks ${m.avoidable.byCause.streak} h, a lint that proved nothing ${m.avoidable.byCause['lint-crash']} h, a credential latched on an outage ${m.avoidable.byCause['credential-latch']} h`],
    ['Streak halts', `${m.streakHalts.total}, of which ${m.streakHalts.flagged} counted a rescued command (${m.streakHalts.byCause['rescued-command']}), a repeated phase (${m.streakHalts.byCause['repeated-phase']}) or a spent wait budget (${m.streakHalts.byCause['wait-budget']})`],
    ['Verify-failed halts', `${m.verifyFailed.halts}, of which ${m.verifyFailed.fromRescued} from a rescued command`],
    ['Spend', `$${m.spend.bookedUsd} booked against $${m.spend.finalUsd} final over ${m.spend.sessions} sessions; phantom $${m.spend.phantomUsd} (${pct(m.spend.phantomShare)})`],
    ['Queue', `${m.queue.episodes} episodes, ${m.queue.episodeHours} h; recorded ${m.queue.recordedHours} h (${pct(m.queue.recordedShare)}); behind the run's own lane ${m.queue.ownRunHours} h (${pct(m.queue.ownRunShare)}), serial ${m.queue.serialHours} h`],
    ['Holder ETA', `${m.holderEta.waits} waits; realised / label ${m.holderEta.medianRealisedOverLabel} at the median (${m.holderEta.errorAtMedian}x off), low bound / realised ${m.holderEta.medianLowOverRealised}, low bound held ${pct(m.holderEta.lowCoverage)}, inside the band ${pct(m.holderEta.bandCoverage)}`],
    ['Phase ETA', m.phaseEta.estimator
      ? `${m.phaseEta.records} phases; estimator within 2x ${pct(m.phaseEta.estimator.within2)}, MALE ${round2(m.phaseEta.estimator.male)}; baseline ${pct(m.phaseEta.baseline.within2)}, ${round2(m.phaseEta.baseline.male)}`
      : `${m.phaseEta.records} phases; the shown estimate is not journalled (--replay scores today's); baseline within 2x ${pct(m.phaseEta.baseline.within2)}, MALE ${round2(m.phaseEta.baseline.male)}`],
    ['Stalls on finished lanes', String(m.stallsOnFinished.count)],
    ['max_turns endings', `${m.closeoutCapResumes.maxTurnsEndings}, of which ${m.closeoutCapResumes.underCloseoutCap} resumes under the closeout cap`],
    ['Unrun verification', m.unrunVerification.count ? `${m.unrunVerification.count}: ${m.unrunVerification.phases.map((p) => `${p.slug} P${p.phase}`).join(', ')}` : '0'],
    ['Model named', `${m.modelNamed.differs} of ${m.modelNamed.starts} phase starts ran on another model`],
    ['Context re-read', `${m.context.cacheReadMTokens} M cache-read tokens over ${m.context.calls} calls in ${m.context.sessions} sessions, ${m.context.meanContextK}K a call; the boot prefix ${m.context.bootShare === null ? 'not measured' : pct(m.context.bootShare)} of it (${m.context.bootMeasured} sessions carry firstContext)`],
  ];
  const width = Math.max(...rows.map(([label]) => label.length));
  const lines = [
    `The week in numbers for ${report.instance}, ${report.since} to ${report.until}${report.replay.length ? ` (replayed with today's ${report.replay.join(', ')} models)` : ''}`,
    '',
    ...rows.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`),
    '',
    'Item 10 targets',
    ...report.targets.map((target) => `  ${target.met === null ? 'n/a   ' : target.met ? 'met   ' : 'missed'}  ${target.target}: ${target.value}`),
  ];
  return `${lines.join('\n')}\n`;
}
