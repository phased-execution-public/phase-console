/**
 * A live phase's progress report — composed by RULES from facts the console
 * already holds (control-tower phase 95, #163).
 *
 * "Why is vca P11 taking so long?" took six sources to answer, and the console
 * showed none of them together: the task list (`phase.tasks`), the session's
 * own log (#138), a sweep's progress, liveness (the open call, the context),
 * the machine's load and the run's own history. This composes one answer from
 * them, in six fields — what it is DOING, what is DONE and LEFT, what it is
 * WAITING ON, WHY it is slow, and WHEN it should finish — plus the task
 * timeline and a plain-language summary written from the same fields.
 *
 * Three rules hold it together:
 *
 *  - **Rules, never a summariser.** Every sentence is a template over a fact;
 *    a model reading the session's last events is deliberately not here
 *    (§Deferred in the plan — "Ask the supervisor" answers on demand).
 *  - **Every figure names its source** — the journal line (`seq`), the session
 *    log line (`uuid`), the task id, the lane field or the machine sample it
 *    came from — so a reader can go and look rather than trust.
 *  - **The ETA is the phase's OWN rate** — the tasks it has finished, the
 *    operation it measures — with a confidence word. The plan-weight forecast
 *    (#66) answers a different question and is not read here.
 *
 * Pure: the service gathers the facts (`readPhaseJournal`, the lane, the
 * session's activity, `os.loadavg`), and this file only reasons over them.
 */
import { PHASE_ETA_CONFIDENCES, SLOW_RULES } from '../../shared/ops-vocab.js';
import { PHASE_IN_FLIGHT, PHASE_STATUSES } from '../../shared/run-lifecycle.js';
import { scanBack } from '../runner/transcript.ts';
import { foldCommand } from '../runner/verify.ts';

type SlowRule = (typeof SLOW_RULES)[number];
type EtaConfidence = (typeof PHASE_ETA_CONFIDENCES)[number];

/**
 * The machine is "above the guard" at this 1-minute load per CPU: past one is
 * saturation, and half again is where timing-sensitive work (a simulator, an
 * e2e sweep) measurably slows and flakes. Phase 100 owns the console's load
 * guard; until it lands this is the report's own line, read from the same
 * `os.loadavg()` sample.
 */
export const LOAD_GUARD_PER_CPU = 1.5;
/** An in-turn wait is named once it is this far toward the local-job guard. */
const NEAR_GUARD = 2 / 3;
/** How far each confidence word widens the ETA either side. */
const SPREAD: Record<Exclude<EtaConfidence, 'none'>, number> = { high: 0.2, medium: 0.4, low: 0.75 };
/** The journal a report reads — the tail, never the file. */
const JOURNAL_BUDGET = 4 * 1024 * 1024;
const JOURNAL_ROWS = 600;
/** The events a report reads: this phase's list, its progress, and every phase's verification. */
const PHASE_EVENTS = new Set(['phase.tasks', 'phase.progress']);
const MIN = 60_000;

/** A statuses a report treats as LIVE: in flight, or held in the queue or on a clock. */
const LIVE = PHASE_STATUSES.filter((s) => (PHASE_IN_FLIGHT as readonly string[]).includes(s) || s === 'queued' || s === 'waiting');

/** Where a figure came from. */
export type ReportSource =
  | { kind: 'journal'; seq: number; event: string }
  | { kind: 'session-line'; line: string }
  | { kind: 'task'; id: string }
  | { kind: 'lane'; field: string }
  | { kind: 'record'; field: string }
  | { kind: 'machine'; sample: 'loadavg' };

export type ReportJournalRow = { seq: number; time: string; event: string; phase?: number; data?: Record<string, unknown> };

type ReportTask = { id: string | null; key?: string; content: string; activeForm?: string; status: string };

export type PhaseReportFacts = {
  slug: string;
  runId: string;
  phase: number;
  now: number;
  record: {
    status?: string;
    startedAt?: string;
    attemptStartedAt?: string;
    tasks?: readonly ReportTask[];
    progress?: { label: string; done: number; of: number; at: string; task?: string };
    liveness?: {
      lastOutputAt?: string;
      openTool?: { id?: string; name: string; since: string; summary?: string };
      tokens?: { context: number; window?: number; stage?: string };
      silence?: { kind: string; sinceMs: number; thresholdMs: number };
    };
    /** The queue's holders, head first — what a queued phase waits behind. */
    waitingOn?: readonly { slug: string; phase?: number; owner?: string; kind?: string }[];
    lockWaitSince?: string;
    parkedUntil?: string;
    parkReason?: string;
  };
  /** This run's journal: this phase's `phase.tasks` / `phase.progress`, any phase's `phase.verify`. */
  journal: readonly ReportJournalRow[];
  /** The session's own recent events (#138), oldest first. */
  activity?: readonly { kind: string; at: string; text?: string; line: string }[];
  load?: { one: number; cpus: number };
};

type Item = { id: string; text: string; status: string; startedAt?: string; durationMs?: number; source: ReportSource[] };

export type PhaseReport = {
  slug: string;
  runId: string;
  phase: number;
  at: string;
  status: string;
  live: boolean;
  doing: {
    task?: { id: string; text: string; since?: string; source: ReportSource[] };
    operation?: { label: string; done: number; of: number; pct: number; at: string; source: ReportSource[] };
    last?: { text: string; at: string; source: ReportSource[] };
  };
  done: { count: number; total: number; items: { id: string; text: string; durationMs?: number; source: ReportSource[] }[] };
  left: { count: number; items: { id: string; text: string; status: string; source: ReportSource[] }[] };
  waitingOn: { kind: 'tool' | 'wait' | 'queue'; text: string; since?: string; until?: string; source: ReportSource[] }[];
  whySlow: { rule: SlowRule; text: string; source: ReportSource[] }[];
  eta: { minutes: { low: number; high: number } | null; confidence: EtaConfidence; basis: string; source: ReportSource[] };
  timeline: Item[];
  summary: string;
};

const mins = (ms: number): number => Math.max(0, Math.round(ms / MIN));
const tokensLabel = (n: number): string =>
  n >= 1_000_000 ? `${Number((n / 1_000_000).toFixed(1))}M` : `${Math.round(n / 1000)}k`;
const loadLabel = (n: number): string => (n >= 10 ? String(Math.round(n)) : n.toFixed(1));
const taskId = (task: ReportTask): string => task.id ?? task.key ?? task.content;
const taskText = (task: ReportTask): string => task.activeForm || task.content;
const journalRef = (row: ReportJournalRow): ReportSource => ({ kind: 'journal', seq: row.seq, event: row.event });

/**
 * When each task was the active one, from the `phase.tasks` lines: a task's
 * window opens on the line that first names it active and closes on the line
 * that names another, or counts one more done.
 */
function taskWindows(rows: readonly ReportJournalRow[]): Map<string, { start: string; end?: string; row: ReportJournalRow }> {
  const windows = new Map<string, { start: string; end?: string; row: ReportJournalRow }>();
  let open: string | null = null;
  let done = -1;
  for (const row of rows) {
    if (row.event !== 'phase.tasks') continue;
    const active = typeof row.data?.active === 'string' ? row.data.active : null;
    const count = Number(row.data?.done);
    const advanced = Number.isFinite(count) && done >= 0 && count > done;
    if (open && (active !== open || advanced)) {
      const window = windows.get(open);
      if (window && !window.end) window.end = row.time;
    }
    if (active) {
      const known = windows.get(active);
      // First named: its window opens. Named again after it closed: it is
      // being worked again, so it runs on from its FIRST start.
      if (!known) windows.set(active, { start: row.time, row });
      else if (known.end && active !== open) delete known.end;
    }
    open = active;
    if (Number.isFinite(count)) done = count;
  }
  return windows;
}

/** The phase's own `phase.progress` lines for one label, oldest first. */
function samplesOf(rows: readonly ReportJournalRow[], label: string): ReportJournalRow[] {
  return rows.filter((r) => r.event === 'phase.progress' && r.data?.label === label);
}

export function composePhaseReport(facts: PhaseReportFacts): PhaseReport {
  const { record, now, phase } = facts;
  const status = record.status ?? 'pending';
  const live = (LIVE as readonly string[]).includes(status);
  const floor = Date.parse(record.attemptStartedAt ?? record.startedAt ?? '');
  const mine = facts.journal
    .filter((r) => r.phase === phase && PHASE_EVENTS.has(r.event))
    .filter((r) => !Number.isFinite(floor) || Date.parse(r.time) >= Math.floor(floor / 1000) * 1000)
    .sort((a, b) => a.seq - b.seq);

  // ---- the task timeline: done, left, the active one ---------------------
  const tasks = record.tasks ?? [];
  const windows = taskWindows(mine);
  const timeline: Item[] = tasks.map((task) => {
    const window = windows.get(taskText(task)) ?? windows.get(task.content);
    const id = taskId(task);
    const end = window?.end ?? (task.status === 'in_progress' ? new Date(now).toISOString() : undefined);
    const durationMs = window && end ? Math.max(0, Date.parse(end) - Date.parse(window.start)) : undefined;
    return {
      id, text: task.content, status: task.status,
      ...(window ? { startedAt: window.start } : {}),
      ...(durationMs != null && (task.status === 'completed' || task.status === 'in_progress') ? { durationMs } : {}),
      source: [{ kind: 'task', id }, ...(window ? [journalRef(window.row)] : [])],
    };
  });
  const finished = timeline.filter((t) => t.status === 'completed');
  const active = timeline.find((t) => t.status === 'in_progress');
  const pending = timeline.filter((t) => t.status !== 'completed' && t.status !== 'in_progress');

  // ---- the measured operation -------------------------------------------
  const lastProgress = [...mine].reverse().find((r) => r.event === 'phase.progress');
  const progress = lastProgress
    ? {
      label: String(lastProgress.data?.label ?? ''), done: Number(lastProgress.data?.done), of: Number(lastProgress.data?.of),
      at: String(lastProgress.data?.at ?? lastProgress.time), source: [journalRef(lastProgress)] as ReportSource[],
    }
    : record.progress
      ? { ...record.progress, source: [{ kind: 'record', field: 'progress' }] as ReportSource[] }
      : undefined;
  const operation = progress && progress.of > 0 && (!progress.task || !active || progress.task === active.id)
    ? {
      label: progress.label, done: progress.done, of: progress.of,
      pct: Math.floor((progress.done / progress.of) * 100), at: progress.at, source: progress.source,
    }
    : undefined;
  let rate: { perMin: number; left: number; source: ReportSource[] } | undefined;
  if (operation) {
    const samples = samplesOf(mine, operation.label);
    const first = samples[0];
    const last = samples[samples.length - 1];
    const span = first && last ? Date.parse(last.time) - Date.parse(first.time) : 0;
    const moved = first && last ? Number(last.data?.done) - Number(first.data?.done) : 0;
    if (span > 0 && moved > 0) {
      rate = { perMin: (moved / span) * MIN, left: operation.of - operation.done, source: [journalRef(first!), journalRef(last!)] };
    }
  }

  const lastWords = [...(facts.activity ?? [])].reverse().find((e) => e.kind === 'text' && e.text);
  const doing: PhaseReport['doing'] = {
    ...(active
      ? { task: { id: active.id, text: active.text, ...(active.startedAt ? { since: active.startedAt } : {}), source: active.source } }
      : {}),
    ...(operation ? { operation } : {}),
    ...(lastWords ? { last: { text: lastWords.text!, at: lastWords.at, source: [{ kind: 'session-line', line: lastWords.line }] } } : {}),
  };

  // ---- waiting on, and why slow — for a live phase only -------------------
  const waitingOn: PhaseReport['waitingOn'] = [];
  const whySlow: PhaseReport['whySlow'] = [];
  const lane = record.liveness;
  const open = lane?.openTool;
  if (live) {
    if (open) {
      waitingOn.push({
        kind: 'tool', since: open.since, source: [{ kind: 'lane', field: 'openTool' }],
        text: `${open.name}${open.summary ? ` \`${open.summary}\`` : ''}, open ${mins(now - Date.parse(open.since))} min`,
      });
    }
    if (status === 'waiting' && (record.parkReason || record.parkedUntil)) {
      waitingOn.push({
        kind: 'wait', source: [{ kind: 'record', field: record.parkReason ? 'parkReason' : 'parkedUntil' }],
        ...(record.parkedUntil ? { until: record.parkedUntil } : {}),
        text: `a declared wait${record.parkReason ? `: ${record.parkReason}` : ''}`
          + (record.parkedUntil ? `, until ${record.parkedUntil}` : ''),
      });
    }
    const holder = record.waitingOn?.[0];
    const holderName = holder ? `${holder.slug}${holder.phase != null ? ` P${holder.phase}` : ''}` : '';
    if (status === 'queued' && holder) {
      waitingOn.push({
        kind: 'queue', source: [{ kind: 'record', field: 'waitingOn' }],
        ...(record.lockWaitSince ? { since: record.lockWaitSince } : {}),
        text: `queued behind ${holderName}${holder.owner ? ` (${holder.owner})` : ''}`,
      });
    }

    // 1. A verification the run already ran, running again.
    const command = open?.name === 'Bash' && open.summary ? foldCommand(open.summary) : '';
    if (command) {
      for (const row of [...facts.journal].filter((r) => r.event === 'phase.verify').sort((a, b) => b.seq - a.seq)) {
        const ran = Array.isArray(row.data?.ran) ? (row.data!.ran as { command?: unknown; ms?: unknown }[]) : [];
        const hit = ran.find((r) => {
          const earlier = typeof r.command === 'string' ? foldCommand(r.command) : '';
          return earlier.length >= 6 && (earlier === command || command.includes(earlier));
        });
        if (!hit) continue;
        const took = Number(hit.ms);
        whySlow.push({
          rule: 'repeat-verification', source: [{ kind: 'lane', field: 'openTool' }, journalRef(row)],
          text: `repeating \`${open!.summary}\`, which this run already ran in P${row.phase ?? '?'}`
            + (Number.isFinite(took) && took > 0 ? ` (${mins(took)} min)` : ''),
        });
        break;
      }
    }
    // 2. The machine, above its guard.
    const load = facts.load;
    if (load && load.cpus > 0 && load.one / load.cpus >= LOAD_GUARD_PER_CPU) {
      whySlow.push({
        rule: 'machine-load', source: [{ kind: 'machine', sample: 'loadavg' }],
        text: `machine load ${loadLabel(load.one)} on ${load.cpus} CPUs is above the guard `
          + `(${loadLabel(load.cpus * LOAD_GUARD_PER_CPU)}): timed work runs slower and may flake`,
      });
    }
    // 3. Context past the wrap-up line.
    const tokens = lane?.tokens;
    if (tokens && (tokens.stage === 'wrap-up' || tokens.stage === 'checkpoint')) {
      whySlow.push({
        rule: 'context-wrap-up', source: [{ kind: 'lane', field: 'tokens' }],
        text: `context ${tokensLabel(tokens.context)}${tokens.window ? ` of ${tokensLabel(tokens.window)}` : ''}: `
          + 'past the wrap-up line, so it will hand off to a fresh session',
      });
    }
    // 4. An in-turn wait on its own job, nearing the guard that parks it.
    const silence = lane?.silence;
    if (silence?.kind === 'own-job' && silence.thresholdMs > 0 && now - silence.sinceMs >= NEAR_GUARD * silence.thresholdMs) {
      whySlow.push({
        rule: 'in-turn-wait', source: [{ kind: 'lane', field: 'silence' }],
        text: `waiting in-turn on its own job for ${mins(now - silence.sinceMs)} min: `
          + `the guard parks it at ${mins(silence.thresholdMs)}`,
      });
    }
    // 5. Held in the queue behind a named holder.
    if (status === 'queued' && holder) {
      const since = Date.parse(record.lockWaitSince ?? '');
      whySlow.push({
        rule: 'queue-hold', source: [{ kind: 'record', field: 'waitingOn' }],
        text: `queued behind ${holderName}${Number.isFinite(since) ? ` for ${mins(now - since)} min` : ''}`,
      });
    }
  }

  // ---- when: the phase's own rate ----------------------------------------
  const eta = etaOf({ live, finished, active, pending, rate, operation, now });

  const report: PhaseReport = {
    slug: facts.slug, runId: facts.runId, phase, at: new Date(now).toISOString(), status, live,
    doing,
    done: { count: finished.length, total: timeline.length, items: finished.map(({ id, text, durationMs, source }) => ({ id, text, ...(durationMs != null ? { durationMs } : {}), source })) },
    left: { count: timeline.length - finished.length, items: [...(active ? [active] : []), ...pending].map(({ id, text, status: s, source }) => ({ id, text, status: s, source })) },
    waitingOn, whySlow, eta, timeline, summary: '',
  };
  report.summary = summaryOf(report);
  return report;
}

function etaOf(input: {
  live: boolean; finished: Item[]; active?: Item; pending: Item[];
  rate?: { perMin: number; left: number; source: ReportSource[] };
  operation?: { label: string };
  now: number;
}): PhaseReport['eta'] {
  if (!input.live) return { minutes: null, confidence: 'none', basis: 'the phase is not running', source: [] };
  const timed = input.finished.filter((t) => t.durationMs != null);
  const avg = timed.length ? timed.reduce((sum, t) => sum + t.durationMs!, 0) / timed.length : null;
  const basis: string[] = [];
  const source: ReportSource[] = timed.flatMap((t) => t.source.filter((s) => s.kind === 'journal'));
  if (avg != null) basis.push(`${timed.length} finished task${timed.length === 1 ? '' : 's'} averaged ${mins(avg)} min`);
  let activeLeft: number | null = null;
  if (input.rate && input.rate.perMin > 0) {
    activeLeft = (input.rate.left / input.rate.perMin) * MIN;
    basis.push(`${input.operation!.label}: ${Number(input.rate.perMin.toFixed(1))} a minute, ${input.rate.left} left`);
    source.push(...input.rate.source);
  } else if (input.active && avg != null) {
    activeLeft = Math.max(0, avg - (input.active.durationMs ?? 0));
  } else if (!input.active) {
    activeLeft = 0;
  }
  const pendingLeft = input.pending.length === 0 ? 0 : avg != null ? input.pending.length * avg : null;
  const score = Math.min(timed.length, 3) + (input.rate ? 1 : 0);
  const confidence: EtaConfidence = score >= 4 ? 'high' : score >= 2 ? 'medium' : score === 1 ? 'low' : 'none';
  if (confidence === 'none' || activeLeft == null || pendingLeft == null) {
    return {
      minutes: null, confidence: 'none', source,
      basis: basis.length ? `${basis.join('; ')} — not enough to say how long the rest takes`
        : 'no task has finished and no operation reports progress',
    };
  }
  const total = activeLeft + pendingLeft;
  const spread = SPREAD[confidence];
  return {
    minutes: { low: Math.floor((total * (1 - spread)) / MIN), high: Math.ceil((total * (1 + spread)) / MIN) },
    confidence, basis: basis.join('; '), source,
  };
}

function summaryOf(report: PhaseReport): string {
  const tasks = report.done.total ? `${report.done.count} of ${report.done.total} tasks done` : 'no task list published';
  if (!report.live) return `Phase ${report.phase} is not running (${report.status}); ${tasks}.`;
  const parts: string[] = [];
  const task = report.doing.task;
  const since = task?.since ? ` (for ${mins(Date.parse(report.at) - Date.parse(task.since))} min)` : '';
  parts.push(task ? `Phase ${report.phase} is on ${task.text}${since}, ${tasks}.` : `Phase ${report.phase} is ${report.status}, ${tasks}.`);
  const op = report.doing.operation;
  if (op) parts.push(`Now: ${op.label} ${op.done}/${op.of}.`);
  if (report.waitingOn.length) parts.push(`Waiting on ${report.waitingOn.map((w) => w.text).join('; ')}.`);
  if (report.whySlow.length) parts.push(`Slow because: ${report.whySlow.map((w) => w.text).join('; ')}.`);
  const eta = report.eta;
  parts.push(eta.minutes
    ? `About ${eta.minutes.low}–${eta.minutes.high} min left (${eta.confidence} confidence: ${eta.basis}).`
    : `No estimate yet: ${eta.basis}.`);
  return parts.join(' ');
}

/**
 * The journal rows a report reads, oldest first: this phase's `phase.tasks`
 * and `phase.progress`, and every phase's `phase.verify` — from the END of the
 * run's journal, within a budget, never the whole file.
 */
export function readPhaseJournal(file: string, phase: number): ReportJournalRow[] {
  const rows: ReportJournalRow[] = [];
  scanBack(file, JOURNAL_BUDGET, (line) => {
    let row: ReportJournalRow;
    try {
      row = JSON.parse(line) as ReportJournalRow;
    } catch {
      return false;
    }
    if (!row || typeof row.event !== 'string' || typeof row.seq !== 'number') return false;
    if (row.event === 'phase.verify' || (row.phase === phase && PHASE_EVENTS.has(row.event))) rows.push(row);
    return rows.length >= JOURNAL_ROWS;
  });
  return rows.reverse();
}
