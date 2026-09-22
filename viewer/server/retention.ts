/**
 * One table for every sink this console writes.
 *
 * Before this module the policy existed, but scattered: `log.ts` rotated its
 * own file, `sessions/registry.ts` swept its own records, `state.ts` pruned run
 * records — and transcripts, task ledgers, outcomes, the ignored pile, folded
 * git traces, the supervisor's stdio and the message ledger grew forever with
 * nobody owning the question. "How long is this kept" had a different answer
 * per sink, none of them written down, and "what is using my disk" had no
 * answer at all.
 *
 * **The planner is pure and the executor is separate.** `planRetention` takes
 * an inventory and a clock and returns a list of actions; `applyRetention`
 * performs them. That split is why every row of the table can be asserted on a
 * fake clock in milliseconds, and why the Settings card can show an operator
 * exactly what the next sweep would do before it does it.
 *
 * **Three verbs, chosen per sink, and the choice is the design:**
 *
 * - `delete` — for a file nothing is writing to. The task inbox, an aged
 *   outcome, a raw git-trace leftover, a rotated message ledger.
 * - `rotate` — `rename` to `.1`, for a file whose writer opens it fresh each
 *   time. Cheap and atomic, and safe precisely because nobody holds a
 *   descriptor across it.
 * - `truncate` — copy-truncate, for a file whose writer holds a descriptor for
 *   the life of the process. This is the supervisor's stdout and stderr, opened
 *   ONCE by launchd. Rotating those with `rename` leaves launchd writing to an
 *   unlinked inode: the console keeps logging, the log file stays empty
 *   forever, and nothing anywhere reports an error. Only `ftruncate` on the
 *   same inode keeps the writer's next line.
 *
 * And one non-verb, `oversized`, which acts on nothing. The ruling ledger IS
 * the record and is never pruned; the console log is rotated by the writer that
 * owns it. For both, the honest thing a sweep can do is say the number out
 * loud, so an operator sees it on the card rather than discovering it as a
 * full disk.
 *
 * **A sidecar ages with its run record, never with its own mtime.** A
 * transcript written once at the start of a run is by definition older than the
 * run; aging it on its own clock would delete the transcript of a run whose
 * record is still being kept, which is the evidence-losing failure this whole
 * phase exists to prevent.
 */

import {
  closeSync,
  existsSync,
  fstatSync,
  ftruncateSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { basename, join } from 'node:path';

import { log } from './log.ts';
import { RETENTION_DEFAULTS, type RetentionPolicy, type RetentionSink, sanitiseRetention } from './retention-policy.ts';

// The table and its coercion are a leaf both this module and `config.ts` read;
// re-exported here so a caller has one spelling to import.
export { RETENTION_DEFAULTS, sanitiseRetention };
export type { RetentionPolicy, RetentionSink };

/**
 * How often the sweep runs. Daily, because nothing in the table moves faster:
 * the two sinks that can grow quickly are bounded by SIZE, and a size bound
 * crossed at noon costs one day of a bigger file rather than a full disk.
 */
export const RETENTION_SWEEP_MS = 24 * 60 * 60_000;

/* ------------------------------------------------------------------ *
 * The inventory
 * ------------------------------------------------------------------ */

export type InventoryFile = {
  sink: RetentionSink;
  path: string;
  bytes: number;
  /** The clock this file is aged by — its own mtime, or its run record's. */
  at: number;
  /** The plan, for the per-plan caps. */
  slug?: string;
  /** The run, so a sidecar can be found from its record. */
  runId?: string;
  /** A live run is never a candidate, whatever the clock says. */
  live?: boolean;
  finished?: boolean;
  /** Set on the `run-<id>.json` record itself, so the cap counts runs once. */
  record?: boolean;
};

export type RetentionInventory = { files: InventoryFile[] };

export type RetentionScan = {
  /** `INSTANCE_STATE_DIR` — console.log, the supervisor stdio, sessions/, git-trace/. */
  instanceDir: string;
  /** `consoleRunsDir(root)` — one directory per plan. `null` with no source directory open. */
  runsDir: string | null;
  /** `<stateHome>/fleet` — Pro; the supervisor's own log. */
  fleetDir?: string | null;
  /** Live run ids by slug. A run a process is driving is never a candidate. */
  live?: Record<string, readonly string[]>;
};

function sizeOf(path: string): { bytes: number; at: number } | null {
  try {
    const stat = statSync(path);
    return { bytes: stat.size, at: stat.mtimeMs };
  } catch {
    return null;
  }
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/** A run id as the run files spell it — the same 8..32 hex `state.ts` uses. */
const RUN_FILE = /^run-([0-9a-f]{8,32})\.json$/;

function push(files: InventoryFile[], file: InventoryFile | null): void {
  if (file) files.push(file);
}

function plain(sink: RetentionSink, path: string, extra: Partial<InventoryFile> = {}): InventoryFile | null {
  const stat = sizeOf(path);
  return stat ? { sink, path, bytes: stat.bytes, at: stat.at, ...extra } : null;
}

/**
 * Walk the console's directories and report every file a policy row names.
 *
 * Reads sizes and times only — never content, with one exception: a run record
 * is opened to learn whether the run is finished and when it last moved, which
 * is the clock its sidecars age by.
 */
export function collectRetention(scan: RetentionScan): RetentionInventory {
  const files: InventoryFile[] = [];

  // ---- the instance directory
  push(files, plain('console-log', join(scan.instanceDir, 'console.log')));
  push(files, plain('console-log', join(scan.instanceDir, 'console.log.1')));
  for (const name of ['console.out.log', 'console.err.log']) {
    push(files, plain('supervisor-stdio', join(scan.instanceDir, name)));
  }

  const sessionsDir = join(scan.instanceDir, 'sessions');
  for (const name of listDir(sessionsDir)) {
    if (!name.endsWith('.events.ndjson')) continue;
    const sessionId = name.slice(0, -'.events.ndjson'.length);
    push(files, plain('session-events', join(sessionsDir, name), {
      // `live` here means "the record it belongs to is still on disk" — an
      // events log is pruned WITH its record, never before it.
      live: existsSync(join(sessionsDir, `${sessionId}.json`)),
    }));
  }

  const consoleTraceDir = join(scan.instanceDir, 'git-trace', 'console');
  for (const name of listDir(consoleTraceDir)) {
    push(files, plain('git-trace', join(consoleTraceDir, name)));
  }

  // ---- one directory per plan
  for (const slug of scan.runsDir ? listDir(scan.runsDir) : []) {
    const planDir = join(scan.runsDir as string, slug);
    let entries: string[];
    try {
      if (!statSync(planDir).isDirectory()) continue;
      entries = readdirSync(planDir).sort();
    } catch {
      continue;
    }
    const liveIds = new Set(scan.live?.[slug] ?? []);

    // The records first: their clock is what every sidecar ages by.
    const recordAt = new Map<string, number>();
    const finished = new Map<string, boolean>();
    for (const name of entries) {
      const id = RUN_FILE.exec(name)?.[1];
      if (!id) continue;
      const path = join(planDir, name);
      const stat = sizeOf(path);
      if (!stat) continue;
      let at = stat.at;
      let done = false;
      try {
        const state = JSON.parse(readFileSync(path, 'utf8')) as { status?: string; updatedAt?: string; createdAt?: string };
        done = state.status === 'finished';
        const stamp = Date.parse(state.updatedAt ?? state.createdAt ?? '');
        if (Number.isFinite(stamp)) at = stamp;
      } catch {
        // An unreadable record is evidence of something worth looking at: it is
        // reported, and `finished` stays false, so nothing sweeps it.
      }
      recordAt.set(id, at);
      finished.set(id, done);
      files.push({
        sink: 'run-records',
        path,
        bytes: stat.bytes,
        at,
        slug,
        runId: id,
        live: liveIds.has(id),
        finished: done,
        record: true,
      });
    }

    for (const name of entries) {
      const path = join(planDir, name);
      if (RUN_FILE.test(name)) continue;

      if (name === 'rulings.ndjson') {
        push(files, plain('rulings', path, { slug }));
        continue;
      }
      if (name === 'messages.ndjson' || name === 'messages.ndjson.1') {
        push(files, plain('messages', path, { slug }));
        continue;
      }
      if (name === 'tasks') {
        for (const leaf of listDir(path)) push(files, plain('task-inbox', join(path, leaf), { slug }));
        continue;
      }
      if (name === 'outcomes') {
        for (const leaf of listDir(path)) {
          const inner = join(path, leaf);
          if (leaf === 'ignored') {
            for (const deep of listDir(inner)) push(files, plain('outcome-inbox', join(inner, deep), { slug }));
            continue;
          }
          push(files, plain('outcome-inbox', inner, { slug }));
        }
        continue;
      }
      if (name === 'git-trace') {
        // `git-trace/<runId>/` — raw Trace2 files the drain has not folded.
        for (const runId of listDir(path)) {
          const inner = join(path, runId);
          for (const leaf of listDir(inner)) {
            push(files, plain('git-trace', join(inner, leaf), { slug, runId, live: liveIds.has(runId) }));
          }
        }
        continue;
      }

      // A run sidecar: `run-<id>.jsonl`, `run-<id>.log.jsonl`,
      // `run-<id>-pN-tasks.ndjson`, `run-<id>-pN-outcome.json`,
      // `run-<id>.git.ndjson`. The id is matched EXACTLY — a prefix match takes
      // the files of a run whose id merely starts the same way.
      const sidecar = /^run-([0-9a-f]{8,32})(?:\.jsonl|\.log\.jsonl|\.git\.ndjson|-p\d+-(?:tasks\.ndjson|outcome\.json))$/
        .exec(name);
      if (!sidecar) continue;
      const id = sidecar[1];
      const stat = sizeOf(path);
      if (!stat) continue;
      files.push({
        sink: 'run-records',
        path,
        bytes: stat.bytes,
        at: recordAt.get(id) ?? stat.at,
        slug,
        runId: id,
        live: liveIds.has(id),
        // A sidecar with no record left is an orphan: the record was swept and
        // this outlived it, so it is as finished as anything gets.
        finished: finished.get(id) ?? true,
      });
    }
  }

  return { files };
}

/* ------------------------------------------------------------------ *
 * The planner
 * ------------------------------------------------------------------ */

export type RetentionAction = {
  kind: 'delete' | 'rotate' | 'truncate' | 'oversized';
  sink: RetentionSink;
  path: string;
  bytes: number;
  /** `truncate` only — how much of the tail survives. */
  keepBytes?: number;
  /** One line an operator can read on the card. */
  why: string;
};

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

function olderThan(file: InventoryFile, now: number, ms: number): boolean {
  return now - file.at > ms;
}

/**
 * The table, applied. Pure: same inventory and same clock, same list — which is
 * what lets the Settings card show an operator the next sweep before it runs.
 */
export function planRetention(
  inventory: RetentionInventory,
  policy: RetentionPolicy,
  now: number,
): RetentionAction[] {
  const actions: RetentionAction[] = [];
  const of = (sink: RetentionSink): InventoryFile[] => inventory.files.filter((one) => one.sink === sink);

  // ---- console.log: the writer owns the rotation; a sweep only says the number.
  for (const file of of('console-log')) {
    if (file.bytes > policy.consoleLogMaxBytes) {
      actions.push({
        kind: 'oversized',
        sink: 'console-log',
        path: file.path,
        bytes: file.bytes,
        why: `past ${policy.consoleLogMaxBytes} bytes; the console rotates this file itself`,
      });
    }
  }

  // ---- the supervisor's stdio, and the fleet's: copy-truncate, never rename.
  for (const sink of ['supervisor-stdio', 'fleet-log'] as const) {
    for (const file of of(sink)) {
      if (file.bytes <= policy.supervisorLogMaxBytes) continue;
      actions.push({
        kind: 'truncate',
        sink,
        path: file.path,
        bytes: file.bytes,
        keepBytes: policy.supervisorLogKeepBytes,
        why: `past ${policy.supervisorLogMaxBytes} bytes; the last ${policy.supervisorLogKeepBytes} are kept`,
      });
    }
  }

  // ---- session event logs: pruned WITH the record, plus an orphan sweep.
  for (const file of of('session-events')) {
    if (file.live) continue;
    actions.push({
      kind: 'delete',
      sink: 'session-events',
      path: file.path,
      bytes: file.bytes,
      why: 'the session record it belongs to is gone',
    });
  }

  // ---- raw git traces: a leftover nobody drained, and a directory cap.
  const traces = of('git-trace').filter((one) => !one.live);
  const leftovers = new Set<string>();
  for (const file of traces) {
    if (!olderThan(file, now, policy.gitTraceLeftoverHours * HOUR)) continue;
    leftovers.add(file.path);
    actions.push({
      kind: 'delete',
      sink: 'git-trace',
      path: file.path,
      bytes: file.bytes,
      why: `no drain folded it within ${policy.gitTraceLeftoverHours} h`,
    });
  }
  const remaining = traces.filter((one) => !leftovers.has(one.path)).sort((a, b) => a.at - b.at);
  let traceBytes = remaining.reduce((sum, one) => sum + one.bytes, 0);
  for (const file of remaining) {
    if (traceBytes <= policy.gitTraceDirMaxBytes) break;
    traceBytes -= file.bytes;
    actions.push({
      kind: 'delete',
      sink: 'git-trace',
      path: file.path,
      bytes: file.bytes,
      why: `the trace directory is past ${policy.gitTraceDirMaxBytes} bytes`,
    });
  }

  // ---- the task inbox: age only. A ledger a session wrote and nobody consumed.
  for (const file of of('task-inbox')) {
    if (!olderThan(file, now, policy.taskInboxDays * DAY)) continue;
    actions.push({
      kind: 'delete',
      sink: 'task-inbox',
      path: file.path,
      bytes: file.bytes,
      why: `older than ${policy.taskInboxDays} days`,
    });
  }

  // ---- the outcome inbox: age, then a per-plan count, oldest first.
  const outcomes = of('outcome-inbox');
  const aged = new Set<string>();
  for (const file of outcomes) {
    if (!olderThan(file, now, policy.outcomeInboxDays * DAY)) continue;
    aged.add(file.path);
    actions.push({
      kind: 'delete',
      sink: 'outcome-inbox',
      path: file.path,
      bytes: file.bytes,
      why: `older than ${policy.outcomeInboxDays} days`,
    });
  }
  const byPlan = new Map<string, InventoryFile[]>();
  for (const file of outcomes) {
    if (aged.has(file.path)) continue;
    const list = byPlan.get(file.slug ?? '') ?? [];
    list.push(file);
    byPlan.set(file.slug ?? '', list);
  }
  for (const [, list] of byPlan) {
    if (list.length <= policy.outcomeInboxMax) continue;
    const oldestFirst = [...list].sort((a, b) => a.at - b.at);
    for (const file of oldestFirst.slice(0, list.length - policy.outcomeInboxMax)) {
      actions.push({
        kind: 'delete',
        sink: 'outcome-inbox',
        path: file.path,
        bytes: file.bytes,
        why: `more than ${policy.outcomeInboxMax} outcomes on one plan`,
      });
    }
  }

  // ---- rulings: reported, never pruned. The file IS the record.
  for (const file of of('rulings')) {
    if (file.bytes <= policy.rulingsOversizedBytes) continue;
    actions.push({
      kind: 'oversized',
      sink: 'rulings',
      path: file.path,
      bytes: file.bytes,
      why: `past ${policy.rulingsOversizedBytes} bytes; the ruling ledger is never pruned`,
    });
  }

  // ---- messages: rotate the live ledger, age out the rotated copy.
  for (const file of of('messages')) {
    if (file.path.endsWith('.ndjson.1')) {
      if (olderThan(file, now, policy.messagesRetainDays * DAY)) {
        actions.push({
          kind: 'delete',
          sink: 'messages',
          path: file.path,
          bytes: file.bytes,
          why: `older than ${policy.messagesRetainDays} days`,
        });
      }
      continue;
    }
    if (file.bytes > policy.messagesRotateBytes) {
      actions.push({
        kind: 'rotate',
        sink: 'messages',
        path: file.path,
        bytes: file.bytes,
        why: `past ${policy.messagesRotateBytes} bytes`,
      });
    }
  }

  // ---- runs: the GLOBAL byte cap. Age and count are `pruneRuns`'s, per plan,
  // because only it knows how to settle a record; this is the floor under it.
  const runs = of('run-records');
  const total = runs.reduce((sum, one) => sum + one.bytes, 0);
  if (total > policy.runsMaxBytes) {
    const byRun = new Map<string, { at: number; files: InventoryFile[]; live: boolean; finished: boolean }>();
    for (const file of runs) {
      const key = `${file.slug ?? ''}\u0000${file.runId ?? ''}`;
      const group = byRun.get(key) ?? { at: file.at, files: [], live: false, finished: true };
      group.at = Math.min(group.at, file.at);
      group.live = group.live || file.live === true;
      group.finished = group.finished && file.finished !== false;
      group.files.push(file);
      byRun.set(key, group);
    }
    const candidates = [...byRun.values()]
      .filter((group) => !group.live && group.finished)
      .sort((a, b) => a.at - b.at);
    let over = total - policy.runsMaxBytes;
    const kept = new Set<string>();
    for (const group of candidates) {
      if (over <= 0) break;
      for (const file of group.files) {
        if (kept.has(file.path)) continue;
        kept.add(file.path);
        over -= file.bytes;
        actions.push({
          kind: 'delete',
          sink: 'run-records',
          path: file.path,
          bytes: file.bytes,
          why: `every run together is past ${policy.runsMaxBytes} bytes`,
        });
      }
    }
  }

  // A stable order, so two plans over one tree compare equal and an operator
  // reading the card twice sees the same list in the same places.
  return actions.sort((a, b) => a.sink.localeCompare(b.sink) || a.path.localeCompare(b.path));
}

/* ------------------------------------------------------------------ *
 * The executor
 * ------------------------------------------------------------------ */

export type RetentionResult = {
  swept: number;
  bytes: number;
  oversized: number;
  failed: { path: string; error: string }[];
};

/**
 * Keep the last `keepBytes` of a file and drop the head, on the SAME inode.
 *
 * The narrow window is deliberate and named: between the `ftruncate` and the
 * write-back, an `O_APPEND` writer's line lands at offset 0 and is then
 * overwritten. Losing at most one line of a supervisor log at the moment it is
 * trimmed is the price of not orphaning the writer's descriptor for the rest of
 * the process's life, which is what `rename` does here.
 */
function copyTruncate(path: string, keepBytes: number): void {
  const fd = openSync(path, 'r+');
  try {
    const size = fstatSync(fd).size;
    if (size <= keepBytes) return;
    const tail = Buffer.alloc(keepBytes);
    readSync(fd, tail, 0, keepBytes, size - keepBytes);
    // Start on a whole line: a tail that begins mid-line is a first row no
    // parser can read and no person can trust.
    const newline = tail.indexOf(0x0a);
    const body = newline >= 0 ? tail.subarray(newline + 1) : tail;
    ftruncateSync(fd, 0);
    writeSync(fd, body, 0, body.length, 0);
  } finally {
    closeSync(fd);
  }
}

/** Perform a plan. Every failure is reported rather than thrown: a sweep that stops at the first unremovable file leaves the rest of the disk full. */
export function applyRetention(actions: readonly RetentionAction[]): RetentionResult {
  const result: RetentionResult = { swept: 0, bytes: 0, oversized: 0, failed: [] };
  for (const action of actions) {
    try {
      if (action.kind === 'oversized') {
        result.oversized += 1;
        log.warn('retention.oversized', {
          sink: action.sink,
          path: basename(action.path),
          bytes: action.bytes,
          why: action.why,
        });
        continue;
      }
      if (action.kind === 'delete') {
        if (!existsSync(action.path)) continue;
        rmSync(action.path, { recursive: true, force: true });
      } else if (action.kind === 'rotate') {
        if (!existsSync(action.path)) continue;
        renameSync(action.path, `${action.path}.1`);
      } else {
        if (!existsSync(action.path)) continue;
        copyTruncate(action.path, action.keepBytes ?? RETENTION_DEFAULTS.supervisorLogKeepBytes);
      }
      result.swept += 1;
      result.bytes += action.bytes;
    } catch (error) {
      result.failed.push({ path: action.path, error: (error as Error).message });
    }
  }
  if (result.failed.length > 0) {
    log.warn('retention.failed', { count: result.failed.length, first: result.failed[0] });
  }
  if (result.swept > 0) {
    log.info('retention.swept', { count: result.swept, bytes: result.bytes });
  }
  return result;
}

/* ------------------------------------------------------------------ *
 * The report
 * ------------------------------------------------------------------ */

export type RetentionSinkReport = {
  sink: RetentionSink;
  files: number;
  bytes: number;
  /** The rows the next sweep would act on, so the card can say so before it runs. */
  due: number;
};

export type RetentionReport = {
  at: string;
  policy: RetentionPolicy;
  sinks: RetentionSinkReport[];
  bytes: number;
  actions: RetentionAction[];
};

const SINKS: readonly RetentionSink[] = [
  'console-log',
  'supervisor-stdio',
  'fleet-log',
  'run-records',
  'task-inbox',
  'outcome-inbox',
  'rulings',
  'session-events',
  'git-trace',
  'messages',
];

/** What `GET /api/debug/retention` answers: every sink's bytes, its policy, and what is due. */
export function retentionReport(
  inventory: RetentionInventory,
  policy: RetentionPolicy,
  now: number,
): RetentionReport {
  const actions = planRetention(inventory, policy, now);
  const sinks = SINKS.map((sink) => {
    const files = inventory.files.filter((one) => one.sink === sink);
    return {
      sink,
      files: files.length,
      bytes: files.reduce((sum, one) => sum + one.bytes, 0),
      due: actions.filter((one) => one.sink === sink).length,
    };
  });
  return {
    at: new Date(now).toISOString(),
    policy,
    sinks,
    bytes: sinks.reduce((sum, one) => sum + one.bytes, 0),
    actions,
  };
}
