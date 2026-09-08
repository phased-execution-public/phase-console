/**
 * The session's TASK LIST — the channel that replaced a tool the CLI took away.
 *
 * The console has always rendered "what it is doing" by folding the CLI's own
 * `TodoWrite` / `TaskCreate` / `TaskUpdate` calls out of the stream. Around
 * 2026-08-14 the CLI stopped provisioning those tools to `claude -p` sessions —
 * measured across 946 machine transcripts: not one call since. Nothing was
 * broken; the pipeline was STARVED, and every unattended run since showed an
 * empty panel while sessions burned tokens searching for the tool their own
 * boot prompt told them to use.
 *
 * So the list gets a channel of its own, built as a deliberate clone of the
 * outcome protocol next door (`outcome.ts`): a session writes NDJSON with
 * `scripts/phase-tasks.sh` to a path this runner injects as `PE_TASKS_FILE`,
 * and the runner tails it. A shell script cannot be un-provisioned.
 *
 * ## What differs from the outcome protocol, and why
 *
 *  - **append-only NDJSON, not one atomic file.** An outcome is a session's
 *    last word and is read once, at exit; a task list is a running commentary
 *    and its whole value is being read WHILE the session works. Appends of one
 *    short line are what make a concurrent tail safe.
 *  - **read incrementally, by byte offset.** `readTaskEvents` returns the new
 *    events and the new offset; a partial trailing line (the writer mid-append)
 *    is left unconsumed for the next read rather than parsed as garbage.
 *  - **the same staleness guard, both halves.** The runner deletes the path
 *    before every spawn, and `written_at` is checked against the attempt — a
 *    leftover list from a crashed attempt must never speak for the next one.
 *
 * ## The wire format is a CONTRACT
 *
 * `scripts/phase-tasks.sh` writes it and this file reads it; the two must be
 * changed together, and `test/phase-tasks.test.ts` runs the real script and
 * asserts this parser agrees with it end to end. Field order there is fixed on
 * purpose (`op` before any free text) so the script can count its own creates
 * with an anchored match no subject can forge.
 */

import { closeSync, openSync, readSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { MAX_TASK_TEXT, TASK_OPS, foldTaskEvent } from '../../shared/task-model.js';
import { runDir } from './state.ts';

/**
 * One row of a task list. Shared with `shared/console-model.js`'s `todos`, by
 * construction: both are produced by `foldTaskEvent`, so a list the server
 * folded and a list the browser folded are the same object shape and the
 * browser can be SEEDED from the server's without a translation step.
 *
 * `id` is `null` only for the CLI's `TaskCreate`, whose id arrives in the tool
 * result rather than its input; `key` is that call's id in the meantime.
 * `phase-tasks.sh` always has an id at create.
 */
export type TaskItem = {
  id: string | null;
  key?: string;
  content: string;
  activeForm?: string;
  status: string;
};

/** One transition, in the shape both producers reach `foldTaskEvent` through. */
export type TaskEvent = {
  op: 'reset' | 'create' | 'update';
  taskId?: string;
  content?: string;
  status?: string;
  activeForm?: string;
};

/**
 * The most one read may take off the file at a time.
 *
 * Bounded rather than capped: what is not read this time is read next time,
 * because the offset only advances over lines actually consumed. A cap that
 * DROPPED the backlog would drop creates, and a list missing its creates is
 * exactly the defect this file exists to fix.
 */
const MAX_TAIL_BYTES = 1024 * 1024;

/** Where this run+phase's task file lives — the value of `PE_TASKS_FILE`. */
export function tasksFileFor(root: string, slug: string, runId: string, phase: number): string {
  return join(runDir(root, slug), `run-${runId}-p${phase}-tasks.ndjson`);
}

/**
 * Where a session NOBODY supervises publishes its list: `phase-tasks.sh` with
 * no `PE_TASKS_FILE` writes `runs/<instance>/<slug>/tasks/phase-NN.ndjson`,
 * beside the outcome inbox and by the same identity rule. A person driving a
 * phase by hand gets the same panel an autopilot lane gets.
 */
export function taskInboxDir(root: string, slug: string): string {
  return join(runDir(root, slug), 'tasks');
}

export function inboxTasksFile(root: string, slug: string, phase: number): string {
  return join(taskInboxDir(root, slug), `phase-${String(phase).padStart(2, '0')}.ndjson`);
}

/** The phase an inbox file name addresses, or null for a name that is not one. */
export function inboxTasksPhase(file: string): number | null {
  const m = /(?:^|\/)phase-(\d{2,})\.ndjson$/.exec(file);
  return m ? Number.parseInt(m[1], 10) : null;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value.slice(0, MAX_TASK_TEXT) : undefined;
}

/**
 * One NDJSON line to a `TaskEvent`, or null for anything not to be trusted.
 *
 * Null is always safe: a line this cannot place simply does not exist, exactly
 * as `readOutcome` degrades to "the session declared nothing".
 */
function parseLine(line: string, expect: { slug: string; phase: number; notBefore?: string }): TaskEvent | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (parsed.version !== 1 || parsed.type !== 'task') return null;
  if (parsed.slug !== expect.slug) return null;
  if (parsed.phase !== expect.phase) return null;
  const op = parsed.op;
  if (typeof op !== 'string' || !TASK_OPS.includes(op)) return null;
  if (typeof parsed.written_at !== 'string' || !parsed.written_at) return null;
  // The same whole-second floor `readOutcome` learned: the script writes
  // `written_at` with `date -u +%Y-%m-%dT%H:%M:%SZ` while `notBefore` is a
  // `toISOString()` carrying milliseconds, so a lexical comparison threw away
  // a line written in the very second the attempt started.
  if (expect.notBefore) {
    const wrote = Date.parse(parsed.written_at);
    const floor = Date.parse(expect.notBefore);
    if (!Number.isFinite(wrote)) return null;
    if (Number.isFinite(floor) && wrote < Math.floor(floor / 1000) * 1000) return null;
  }
  return {
    op: op as TaskEvent['op'],
    ...(text(parsed.id) ? { taskId: text(parsed.id) } : {}),
    ...(text(parsed.subject) ? { content: text(parsed.subject) } : {}),
    ...(text(parsed.status) ? { status: text(parsed.status) } : {}),
    ...(text(parsed.active_form) ? { activeForm: text(parsed.active_form) } : {}),
  };
}

/**
 * Read whatever has been appended since byte `from`.
 *
 * Returns the validated events and the offset to resume at — which advances
 * only over COMPLETE lines, so a write caught mid-append is re-read whole next
 * time instead of being parsed as a truncated record and discarded for ever.
 */
export function readTaskEvents(
  path: string,
  expect: { slug: string; phase: number; notBefore?: string },
  from = 0,
): { events: TaskEvent[]; at: number } {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return { events: [], at: from };
  }
  // A file that SHRANK is a different file — a retry armed a fresh path, or the
  // run directory was cleaned. Start again rather than reading from an offset
  // that now points into the middle of somebody else's line.
  const start = size < from ? 0 : from;
  if (size <= start) return { events: [], at: start };

  const want = Math.min(size - start, MAX_TAIL_BYTES);
  let buf: Buffer;
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    buf = Buffer.allocUnsafe(want);
    const read = readSync(fd, buf, 0, want, start);
    if (read < want) buf = buf.subarray(0, read);
  } catch {
    return { events: [], at: start };
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best-effort */ } }
  }

  const cut = buf.lastIndexOf(0x0a);
  if (cut < 0) return { events: [], at: start };

  const events: TaskEvent[] = [];
  for (const line of buf.subarray(0, cut + 1).toString('utf8').split('\n')) {
    if (!line) continue;
    const event = parseLine(line, expect);
    if (event) events.push(event);
  }
  return { events, at: start + cut + 1 };
}

/** Fold a batch onto a list. Returns the same array when nothing changed. */
export function foldTasks(tasks: TaskItem[] | undefined, events: readonly TaskEvent[]): TaskItem[] {
  let list: TaskItem[] = tasks ?? [];
  for (const event of events) list = foldTaskEvent(list, event) as TaskItem[];
  return list;
}

/** Remove a consumed (or stale) task file. Never throws — best-effort. */
export function consumeTasks(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch { /* best-effort */ }
}

/**
 * The list a session NOBODY supervises published — the inbox file for
 * (slug, phase), folded from the top.
 *
 * `inboxTasksFile` was write-only: `phase-tasks.sh` wrote it whenever
 * `PE_TASKS_FILE` was unset (every hand-driven phase, every pty reviewer),
 * and no server code ever read it back — so "a person driving a phase by hand
 * gets the same panel an autopilot lane gets" was a sentence in a comment.
 * No `notBefore` floor: an unsupervised list has no attempt clock, and its
 * `reset` is what starts it over. Empty for a phase nobody published for.
 */
export function readInboxTasks(root: string, slug: string, phase: number): TaskItem[] {
  const { events } = readTaskEvents(inboxTasksFile(root, slug, phase), { slug, phase });
  return foldTasks(undefined, events);
}

/**
 * Fold each QA reviewer's inbox onto its pty session — what `GET /api/terminal`
 * serves in place of the bare registry state.
 *
 * A "QA this phase" session publishes its list through `phase-tasks.sh` into
 * the inbox its `PE_TASKS_FILE` names (set at mint by `agent.ts`), and until
 * this nothing read it: the Sessions page drew the reviewer with no task line
 * while the autopilot lane beside it had one. Structural over the session
 * shape so a test drives it without a Terminals. A session that is not a
 * reviewer, a phase nobody published for, or a root that is not open passes
 * through untouched — never an empty list stamped on a session that said
 * nothing. An ENDED reviewer keeps its last list: the record outlives the
 * process so the page can say what it did, and that list is part of it.
 */
export function foldInboxTasks<S extends { kind: string; meta?: { qa?: { slug: string; phase: number } } }>(
  sessions: readonly S[],
  root: string | undefined,
): (S & { tasks?: TaskItem[] })[] {
  return sessions.map((session) => {
    const qa = session.kind === 'claude' ? session.meta?.qa : undefined;
    if (!qa || !root) return session;
    const tasks = readInboxTasks(root, qa.slug, qa.phase);
    return tasks.length ? { ...session, tasks } : session;
  });
}
