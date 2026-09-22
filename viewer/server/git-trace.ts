/**
 * Git's own Trace2 event stream, folded into one line per process.
 *
 * `git.command` — the seam's line — says what the console ASKED git to do.
 * This says what git then DID: which children it forked, which worktree it
 * concluded it was in, how long it took inside, and the errors it printed to
 * nobody. A merge that fails has its reason here and only here.
 *
 * **Off by default, and it has to be.** Git writes one JSON file per process
 * into the directory named by `GIT_TRACE2_EVENT`, and a single drive runs
 * hundreds of git processes. Left on, this is a directory that grows without
 * bound in the state folder — which is the failure mode the whole retention
 * half of this plan exists to prevent. So: `PHASE_CONSOLE_GIT_TRACE2=1` for the
 * console's own git, `=sessions` to trace what the spawned sessions run too,
 * and any other word is OFF. A tracer that turns itself on by accident is
 * worse than no tracer.
 *
 * **The join is the SID**, and it is the reason this is worth having. Git forms
 * its session id as `<GIT_TRACE2_PARENT_SID>/<its own>`, and the seam sets that
 * parent to `pc-<traceId>-<spanId>`. So a raw Trace2 file, found on its own
 * with no other record surviving, still says which span ran it.
 *
 * **The raw file is deleted once folded.** The folded line is strictly more
 * useful than the twenty events it replaces, and leaving both would be paying
 * the disk cost twice for the worse copy.
 */

import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { log } from './log.ts';
import { parseGitSid } from './trace.ts';

/** `off` · `console` (this process's git) · `sessions` (and the sessions' too). */
export type GitTraceMode = 'off' | 'console' | 'sessions';

/** One git process, folded. */
export type GitTrace = {
  sid: string;
  /** The half of the sid git inherited, when it inherited one. */
  parentSid?: string;
  /** Recovered from `parentSid` when the seam set it. */
  traceId?: string;
  spanId?: string;
  argv?: string[];
  /** Git's own name for the command — `merge`, `status`, `rev-parse`. */
  cmd?: string;
  /** The worktree git CONCLUDED it was in, which is not always the cwd it was given. */
  worktree?: string;
  /** Milliseconds, from git's own `t_abs`. Absent when the exit was never written. */
  ms?: number;
  /** Absent — not `0` — when the process was cut off before it exited. */
  code?: number;
  children: number;
  errors: string[];
};

/** Folded traces per drain. Beyond it the record stops; the cleanup does not. */
const DEFAULT_CAP = 2_000;

type Trace2Event = {
  event?: string;
  sid?: string;
  argv?: unknown;
  name?: string;
  path?: string;
  msg?: string;
  code?: unknown;
  t_abs?: unknown;
};

export function gitTraceMode(env: NodeJS.ProcessEnv = process.env): GitTraceMode {
  const raw = (env.PHASE_CONSOLE_GIT_TRACE2 ?? '').trim().toLowerCase();
  if (raw === '1' || raw === 'true' || raw === 'console') return 'console';
  if (raw === 'sessions') return 'sessions';
  return 'off';
}

/**
 * The env a child needs to write its Trace2 file here.
 *
 * Empty when tracing is off, so the call sites spread it unconditionally and
 * never branch — and so a child NEVER inherits a `GIT_TRACE2_EVENT` the
 * operator's own shell exported, which would write git's events somewhere the
 * console will never drain.
 */
export function gitTraceEnv(dir: string | null): Record<string, string | undefined> {
  if (!dir) return { GIT_TRACE2_EVENT: undefined, GIT_TRACE2_EVENT_NESTING: undefined };
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return { GIT_TRACE2_EVENT: undefined, GIT_TRACE2_EVENT_NESTING: undefined };
  }
  // Nesting 2 keeps a child's own children out: one level below the command is
  // where the interesting forks are, and below that it is git's plumbing
  // talking to itself.
  return { GIT_TRACE2_EVENT: dir, GIT_TRACE2_EVENT_NESTING: '2' };
}

/**
 * Where git's events are being collected right now, or `null` for nowhere.
 *
 * Module-level rather than threaded through the seam's options: the seam is
 * called from a hundred sites and none of them know whether the operator asked
 * for Trace2. The runner sets it for the duration of a drive and clears it
 * after, so the answer moves with the run rather than with the process.
 */
let collecting: string | null = null;

export function setGitTraceDir(dir: string | null): void {
  collecting = gitTraceMode() === 'off' ? null : dir;
}

export function gitTraceDir(): string | null {
  return collecting;
}

/**
 * Fold one Trace2 event file.
 *
 * `null` for anything that is not one — an empty file, a half-written first
 * line, a file some other tool left in the directory. A tracer that throws on
 * a malformed file is a tracer that takes the drive down.
 */
export function foldTrace2(text: string): GitTrace | null {
  const events: Trace2Event[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Trace2Event;
      if (parsed && typeof parsed === 'object') events.push(parsed);
    } catch {
      /* a truncated tail line, or a file that was never Trace2 */
    }
  }
  if (!events.length) return null;

  const sid = events.find((e) => typeof e.sid === 'string')?.sid;
  if (!sid) return null;

  // Git appends its own sid after a '/', so the parent is everything before
  // the LAST separator — a parent sid may itself be a nested one.
  const cut = sid.lastIndexOf('/');
  const parentSid = cut === -1 ? undefined : sid.slice(0, cut);
  const joined = parseGitSid(sid);

  const trace: GitTrace = { sid, children: 0, errors: [] };
  if (parentSid) trace.parentSid = parentSid;
  if (joined) {
    trace.traceId = joined.traceId;
    trace.spanId = joined.spanId;
  }

  for (const event of events) {
    switch (event.event) {
      case 'start':
        if (Array.isArray(event.argv)) trace.argv = event.argv.map(String);
        break;
      case 'cmd_name':
        if (typeof event.name === 'string') trace.cmd = event.name;
        break;
      case 'worktree':
        if (typeof event.path === 'string') trace.worktree = event.path;
        break;
      case 'child_start':
        trace.children += 1;
        break;
      case 'error':
        if (typeof event.msg === 'string') trace.errors.push(event.msg);
        break;
      case 'exit':
      case 'atexit':
        if (typeof event.code === 'number') trace.code = event.code;
        if (typeof event.t_abs === 'number') trace.ms = Math.round(event.t_abs * 1000);
        break;
      default:
        break;
    }
  }
  return trace;
}

/**
 * Fold every file in the directory, record the lines, and clear it.
 *
 * The cap bounds the RECORD, not the cleanup: past it the files are still
 * removed, because a capped tracer that leaves its input behind is the disk
 * problem it was supposed to avoid. `git.trace-capped` is written once per
 * drain, not once per file.
 */
export function drainGitTraces(
  dir: string,
  opts: { sink: string; cap?: number },
): { folded: number; capped: boolean } {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return { folded: 0, capped: false }; // never created, or already swept
  }

  const cap = opts.cap ?? DEFAULT_CAP;
  const lines: string[] = [];
  let folded = 0;
  let capped = false;

  for (const name of names) {
    const path = join(dir, name);
    try {
      if (statSync(path).isDirectory()) continue;
      if (folded < cap) {
        const trace = foldTrace2(readFileSync(path, 'utf8'));
        if (trace) {
          lines.push(JSON.stringify(trace));
          folded += 1;
        }
      } else {
        capped = true;
      }
    } catch {
      /* unreadable — it still gets removed below */
    }
    try { rmSync(path, { force: true }); } catch { /* a racing drain took it */ }
  }

  if (lines.length) {
    try {
      mkdirSync(dirname(opts.sink), { recursive: true });
      appendFileSync(opts.sink, `${lines.join('\n')}\n`, 'utf8');
    } catch (error) {
      log.warn('git.trace-write-failed', { sink: opts.sink, error });
    }
  }
  if (capped) log.warn('git.trace-capped', { dir, cap, seen: names.length });

  return { folded, capped };
}
