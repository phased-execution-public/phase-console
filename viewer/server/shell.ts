/**
 * The one seam every child process the console runs goes through.
 *
 * There were nine git helpers in six files, each with its own error semantics
 * (`''`, `null`, `{ok,stdout}`, `{ok,stdout,stderr}`) and its own inline env
 * literal, and not one of them wrote down what it ran. "Which git command did
 * the console run, in which tree, and what did it say" was unanswerable from
 * any record the console kept — so a merge that went wrong could be
 * reconstructed only by re-running it by hand and hoping the tree had not
 * moved. The helpers stay, because their return shapes are what their callers
 * read; what they now share is where the process is actually started, what env
 * it inherits, and the one line each command leaves behind.
 *
 * Four rules the callers depend on.
 *
 * **It never throws.** Every one of those helpers treated a spawn failure as a
 * value; a seam that threw would turn a missing binary into a crashed drive.
 * A process that never started is `{ok: false, code: null, error}` — which is a
 * different fact from a process that ran and exited non-zero, and callers that
 * care can tell them apart.
 *
 * **Capture is bounded at BOTH ends.** A `git log` over a large repository is
 * megabytes; the log line that carried it would be the thing that filled the
 * disk. Keeping only the head would be worse than useless: an error message is
 * always last.
 *
 * **A failure nobody expected is louder than one somebody did.** Speculative
 * commands (`rev-parse` on a ref that may not exist) declare `expectFailure`
 * and stay at `debug`. Everything else surfaces at `info` when it fails,
 * because an unexpected git failure is the single most useful thing this log
 * can tell anyone, and it must not need a debug channel turned on in advance.
 *
 * **Argv literals stay at the call sites.** `never-push.test.ts` reads the
 * server's source *syntactically* — it extracts array literals and refuses any
 * holding a remote or mutating git verb. A seam that built verbs from variables
 * would not turn that test red; it would turn it VACUOUS. So this file contains
 * no argv literal of its own, and adapters pass their literal arrays through.
 */

import { type ChildProcess, spawn } from 'node:child_process';

import { count } from './counters.ts';
import { gitTraceDir, gitTraceEnv } from './git-trace.ts';
import { log } from './log.ts';
import { envCarrier } from './trace.ts';

/**
 * Which family a command belongs to — the event name, and the word an operator
 * puts in `PHASE_CONSOLE_DEBUG` to see it.
 */
export type ShellChannel = 'git' | 'engine' | 'shell';

export type ShellOptions = {
  channel: ShellChannel;
  /** What this command is FOR, in one word or two. It rides the line. */
  intent: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
  /**
   * How much output to keep, and from where.
   *
   * `ends` (the default) keeps the head and the tail — right for anything a
   * person will read, because an error message is always last. `head` keeps a
   * prefix and nothing else, which is what a caller whose output gets PARSED
   * must ask for: an `…elided…` marker spliced into the middle of a
   * machine-readable stream is not a truncation, it is a lie. It is also
   * exactly what the `maxBuffer` these adapters replaced used to deliver.
   */
  capture?: { keep: number; mode?: 'ends' | 'head' };
  /**
   * A non-zero exit is this command's ANSWER, not a fault — keep it at `debug`.
   * For the speculative reads: does this ref exist, is this tree a repository.
   */
  expectFailure?: boolean;
};

export type ShellRun = {
  ok: boolean;
  /** `null` when the process never started, or was killed by a signal. */
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  ms: number;
  /** How much output was thrown away. `0` means what you have is all of it. */
  truncatedBytes: number;
  timedOut: boolean;
  /** Present only when the process could not be started or was killed by us. */
  error?: Error;
};

/** 64 KB total per stream, split head and tail. */
const DEFAULT_KEEP = 64 * 1024;
/** What rides the log line — much smaller than what the caller gets back. */
const LINE_TAIL = 2 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Keep the first and last `keep/2` bytes, and say how much went missing.
 *
 * Collected as chunks and joined once: concatenating a string per `data` event
 * is quadratic, and a command producing megabytes is exactly when that bites.
 */
class BoundedCapture {
  private head: Buffer[] = [];
  private headBytes = 0;
  private tail: Buffer[] = [];
  private tailBytes = 0;
  private elided = 0;
  private readonly half: number;
  private readonly headOnly: boolean;

  constructor(keep: number, mode: 'ends' | 'head' = 'ends') {
    this.headOnly = mode === 'head';
    this.half = this.headOnly ? Math.max(1, keep) : Math.max(1, Math.floor(keep / 2));
  }

  push(chunk: Buffer): void {
    if (this.headOnly) {
      const room = this.half - this.headBytes;
      if (room > 0) {
        const take = chunk.subarray(0, room);
        this.head.push(take);
        this.headBytes += take.length;
        this.elided += chunk.length - take.length;
      } else {
        this.elided += chunk.length;
      }
      return;
    }
    if (this.headBytes < this.half) {
      const room = this.half - this.headBytes;
      const take = chunk.subarray(0, room);
      this.head.push(take);
      this.headBytes += take.length;
      chunk = chunk.subarray(take.length);
      if (!chunk.length) return;
    }
    this.tail.push(chunk);
    this.tailBytes += chunk.length;
    // Drop from the FRONT of the tail: what we are keeping is the end.
    while (this.tailBytes > this.half && this.tail.length) {
      const first = this.tail[0];
      const excess = this.tailBytes - this.half;
      if (first.length <= excess) {
        this.tail.shift();
        this.tailBytes -= first.length;
        this.elided += first.length;
      } else {
        this.tail[0] = first.subarray(excess);
        this.tailBytes -= excess;
        this.elided += excess;
      }
    }
  }

  get truncated(): number {
    return this.elided;
  }

  text(): string {
    const head = Buffer.concat(this.head).toString('utf8');
    if (this.headOnly) return head;
    const tail = Buffer.concat(this.tail).toString('utf8');
    if (!this.elided) return head + tail;
    return `${head}\n…${this.elided} bytes elided…\n${tail}`;
  }
}

/** The last `LINE_TAIL` characters of whatever the command said, for the line. */
function lineTail(run: ShellRun): string {
  const said = (run.stderr.trim() || run.stdout.trim()).trim();
  return said.length > LINE_TAIL ? said.slice(-LINE_TAIL) : said;
}

/**
 * Run a command and write one line about it.
 *
 * The line is `<channel>.command`, at `debug` — except an unexpected failure,
 * which is `info` so it is visible with no channel turned on, and a timeout,
 * which is `warn` because a command that had to be killed is a fault whatever
 * the caller expected of its exit code.
 */
export async function shell(file: string, argv: readonly string[], options: ShellOptions): Promise<ShellRun> {
  const started = Date.now();
  const keep = options.capture?.keep ?? DEFAULT_KEEP;
  const mode = options.capture?.mode ?? 'ends';
  const out = new BoundedCapture(keep, mode);
  // stderr is always kept from both ends: nothing parses it, and its last line
  // is the one that says what went wrong.
  const err = new BoundedCapture(keep);

  const run = await new Promise<ShellRun>((resolve) => {
    let settled = false;
    let timedOut = false;
    let child: ChildProcess;

    const finish = (partial: Omit<ShellRun, 'stdout' | 'stderr' | 'ms' | 'truncatedBytes' | 'timedOut'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ...partial,
        stdout: out.text(),
        stderr: err.text(),
        ms: Date.now() - started,
        truncatedBytes: out.truncated + err.truncated,
        timedOut,
      });
    };

    // A timer rather than spawn's own `timeout`: we need to know that WE killed
    // it, which the option cannot tell us apart from the process dying on its own.
    const timer = setTimeout(() => {
      timedOut = true;
      try { child?.kill('SIGKILL'); } catch { /* already gone */ }
    }, options.timeout ?? DEFAULT_TIMEOUT_MS);

    try {
      child = spawn(file, [...argv], {
        cwd: options.cwd,
        // `envCarrier()` last and always: outside a span it states each key as
        // `undefined`, which DELETES an inherited TRACEPARENT rather than
        // passing a stranger's trace to the child. `gitTraceEnv` is the same
        // shape for the same reason — with tracing off it states
        // `GIT_TRACE2_EVENT: undefined`, so a variable the operator's own shell
        // exported cannot send git's events somewhere nothing will drain.
        env: {
          ...(options.env ?? process.env),
          ...(options.channel === 'git' ? gitTraceEnv(gitTraceDir()) : {}),
          ...envCarrier(),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish({ ok: false, code: null, signal: null, error: error as Error });
      return;
    }

    child.stdout?.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', (error) => finish({ ok: false, code: null, signal: null, error }));
    child.on('close', (code, signal) => {
      if (timedOut) {
        finish({
          ok: false,
          code: null,
          signal,
          error: new Error(`timed out after ${options.timeout ?? DEFAULT_TIMEOUT_MS}ms`),
        });
        return;
      }
      finish({ ok: code === 0, code, signal });
    });
  });

  record(file, argv, options, run);
  return run;
}

/**
 * The three event names, written out.
 *
 * Interpolating the channel into the event name would be one line instead of
 * nine — and a name built that way can never have a row in
 * `docs/journal-events.md`, which `docs-parity.test.ts` refuses in both
 * directions. (Its scan reads comments too, which is why this paragraph
 * describes the shape rather than quoting it.) The names have to be literals in
 * a log-call position, or they are names no document can list and no `grep` can
 * find.
 */
const WRITE: Record<ShellChannel, Record<'debug' | 'info' | 'warn', (data: Record<string, unknown>) => void>> = {
  git: {
    debug: (data) => log.debug('git.command', data),
    info: (data) => log.info('git.command', data),
    warn: (data) => log.warn('git.command', data),
  },
  engine: {
    debug: (data) => log.debug('engine.command', data),
    info: (data) => log.info('engine.command', data),
    warn: (data) => log.warn('engine.command', data),
  },
  shell: {
    debug: (data) => log.debug('shell.command', data),
    info: (data) => log.info('shell.command', data),
    warn: (data) => log.warn('shell.command', data),
  },
};

function record(file: string, argv: readonly string[], options: ShellOptions, run: ShellRun): void {
  const write = WRITE[options.channel];
  // The VERB, not the argv: `git` has a closed-in-practice set of verbs and an
  // unbounded set of arguments, and a counter keyed by the second is how a
  // metrics endpoint runs a machine out of memory.
  const verb = String(argv[0] ?? '').slice(0, 64);
  const ok = run.ok ? 'true' : 'false';
  if (options.channel === 'git') {
    count('git_commands_total', [verb, ok]);
    count('git_command_seconds_total', [verb], run.ms / 1000);
  } else if (options.channel === 'engine') {
    count('engine_calls_total', [options.intent, 'miss']);
  } else {
    count('shell_commands_total', [file, ok]);
  }
  const data: Record<string, unknown> = {
    argv: [file, ...argv],
    intent: options.intent,
    ms: run.ms,
    code: run.code,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(run.signal === null ? {} : { signal: run.signal }),
    ...(run.timedOut ? { timedOut: true } : {}),
    ...(run.truncatedBytes ? { truncatedBytes: run.truncatedBytes } : {}),
  };

  if (run.timedOut) {
    write.warn({ ...data, tail: lineTail(run) });
    return;
  }
  if (!run.ok && !options.expectFailure) {
    write.info({ ...data, tail: lineTail(run) });
    return;
  }
  // The tail is only worth its bytes when something went wrong, or when
  // somebody asked for this channel by name.
  write.debug(run.ok ? data : { ...data, tail: lineTail(run) });
}

/**
 * Record a command this seam did not run.
 *
 * For the one site that cannot use it: §Verification streams a command's output
 * to a live reader as it arrives, so it owns its own spawn. It still belongs on
 * the same axis as everything else, and the line says `streamed` so nobody
 * looks for a tail that was never collected.
 */
export function shellNote(note: {
  channel: ShellChannel;
  intent: string;
  argv: readonly string[];
  cwd?: string;
  ms: number;
  code: number | null;
}): void {
  WRITE[note.channel].debug({
    argv: [...note.argv],
    intent: note.intent,
    ms: note.ms,
    code: note.code,
    ...(note.cwd === undefined ? {} : { cwd: note.cwd }),
    streamed: true,
  });
}
