/**
 * The retention TABLE — the leaf `config.ts` and `retention.ts` share.
 *
 * This is `run-paths.ts`'s problem again and it has the same answer. The
 * sweeper (`retention.ts`) logs what it did, so it imports `log.ts`, which
 * imports `config.ts` for the log file's path — and `config.ts` needs the
 * policy defaults at module load, to build `DEFAULT_PREFS`. Importing the
 * sweeper from `config.ts` would close that ring. The numbers and their
 * coercion moved down here instead, importing nothing; `retention.ts`
 * re-exports them, so every caller keeps one spelling.
 *
 * Nothing in this file touches the disk or the clock. It is the table an
 * operator edits and the rule that stops them editing it into a sweep that
 * deletes everything.
 */

export type RetentionSink =
  | 'console-log'
  | 'supervisor-stdio'
  | 'fleet-log'
  | 'run-records'
  | 'task-inbox'
  | 'outcome-inbox'
  | 'rulings'
  | 'session-events'
  | 'git-trace'
  | 'messages';

export type RetentionPolicy = {
  /** `console.log`; rotation itself is `log.ts`'s — this is the number reported. */
  consoleLogMaxBytes: number;
  /** `console.out.log` / `console.err.log`, past which they are copy-truncated. */
  supervisorLogMaxBytes: number;
  /** How much of the TAIL a copy-truncate keeps. */
  supervisorLogKeepBytes: number;
  /** A finished run record's age, in days. */
  runRetainDays: number;
  /** Runs kept per plan regardless of age, newest first. */
  runRetainMin: number;
  /** Every run of every plan, together, oldest finished first past this. */
  runsMaxBytes: number;
  /** `<plan>/tasks/phase-NN.ndjson`, in days. */
  taskInboxDays: number;
  /** `rulings.ndjson` is never pruned; past this it is reported. */
  rulingsOversizedBytes: number;
  /** `<plan>/outcomes/` and `outcomes/ignored/`, in days. */
  outcomeInboxDays: number;
  /** …and by count, per plan, oldest first. */
  outcomeInboxMax: number;
  /** `sessions/<id>.events.ndjson`; the cap is enforced at write time too. */
  sessionEventsMaxBytes: number;
  /** A raw Trace2 file nobody drained, in hours. */
  gitTraceLeftoverHours: number;
  /** The console's own git-trace directory, oldest first past this. */
  gitTraceDirMaxBytes: number;
  /** `messages.ndjson` is rotated to `.1` past this. */
  messagesRotateBytes: number;
  /** …and the rotated copy goes after this many days. */
  messagesRetainDays: number;
};

/**
 * The shipped table.
 *
 * Generous where the file is evidence somebody will want (30 days of runs, 90
 * of messages), tight where it is exhaust (a raw git trace nobody drained
 * within a day is a leftover). The two-gigabyte total is the one number chosen
 * against the disk rather than against the question: it is the point past which
 * a laptop notices, and it is a floor under the per-plan rules rather than a
 * replacement for them.
 */
export const RETENTION_DEFAULTS: RetentionPolicy = Object.freeze({
  consoleLogMaxBytes: 16 * 1024 * 1024,
  supervisorLogMaxBytes: 32 * 1024 * 1024,
  supervisorLogKeepBytes: 8 * 1024 * 1024,
  runRetainDays: 30,
  runRetainMin: 20,
  runsMaxBytes: 2 * 1024 * 1024 * 1024,
  taskInboxDays: 30,
  rulingsOversizedBytes: 16 * 1024 * 1024,
  outcomeInboxDays: 30,
  outcomeInboxMax: 200,
  sessionEventsMaxBytes: 1024 * 1024,
  gitTraceLeftoverHours: 24,
  gitTraceDirMaxBytes: 64 * 1024 * 1024,
  messagesRotateBytes: 8 * 1024 * 1024,
  messagesRetainDays: 90,
});

/**
 * A value from `config.json` is a number this console DELETES files by, so
 * every one of them is checked rather than trusted. A string, a negative or a
 * NaN is the default — and a zero is too, because a zero cap here does not mean
 * "unbounded", it means "delete everything", which is not a policy anybody
 * meant to write.
 */
export function sanitiseRetention(parsed: Partial<RetentionPolicy> | undefined): RetentionPolicy {
  const raw = (parsed ?? {}) as Record<string, unknown>;
  const positive = (key: keyof RetentionPolicy): number => {
    const value = raw[key];
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : RETENTION_DEFAULTS[key];
  };
  const out: RetentionPolicy = {
    consoleLogMaxBytes: positive('consoleLogMaxBytes'),
    supervisorLogMaxBytes: positive('supervisorLogMaxBytes'),
    supervisorLogKeepBytes: positive('supervisorLogKeepBytes'),
    runRetainDays: positive('runRetainDays'),
    // The one cap where zero IS meaningful: "keep no run past its age".
    runRetainMin:
      typeof raw.runRetainMin === 'number' && Number.isFinite(raw.runRetainMin) && raw.runRetainMin >= 0
        ? raw.runRetainMin
        : RETENTION_DEFAULTS.runRetainMin,
    runsMaxBytes: positive('runsMaxBytes'),
    taskInboxDays: positive('taskInboxDays'),
    rulingsOversizedBytes: positive('rulingsOversizedBytes'),
    outcomeInboxDays: positive('outcomeInboxDays'),
    outcomeInboxMax: positive('outcomeInboxMax'),
    sessionEventsMaxBytes: positive('sessionEventsMaxBytes'),
    gitTraceLeftoverHours: positive('gitTraceLeftoverHours'),
    gitTraceDirMaxBytes: positive('gitTraceDirMaxBytes'),
    messagesRotateBytes: positive('messagesRotateBytes'),
    messagesRetainDays: positive('messagesRetainDays'),
  };
  // A tail bigger than the cap that triggers the trim is a trim that never
  // shrinks anything — the sweep would run every day and change nothing.
  if (out.supervisorLogKeepBytes >= out.supervisorLogMaxBytes) {
    out.supervisorLogKeepBytes = Math.max(1, Math.floor(out.supervisorLogMaxBytes / 4));
  }
  return out;
}
