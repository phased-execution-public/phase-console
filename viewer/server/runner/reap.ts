/**
 * A test runner a session started does not outlive it (one-pool phase 26, #222).
 *
 * Two `node --test` runs from control-tower sessions spun at ~70 % CPU for
 * 8 h 23 min and 41 min after their sessions ended, parented by launchd, and
 * every console's load guard on the laptop counted them. The session's own
 * process group could not have reached them: Claude Code runs each Bash
 * command in a process group OF ITS OWN (measured: the tool's zsh is its own
 * group leader, not a member of the `claude` group the console spawned
 * `detached`), so a background `node --test &` is in that command's group, and
 * once the command's shell exits its parent is pid 1 and nothing names the
 * session it came from.
 *
 * So the reaper remembers. While a session lives it samples the machine's
 * process table (`pid.ts` `processTable`, one `ps` for every live session,
 * every `REAP_SAMPLE_MS`) and records each DESCENDANT of the session's leader
 * — its pid and its start time, which together are an identity a recycled pid
 * cannot fake. When the session ends:
 *
 *  1. its own process group (`-leader`) is ended through the signal ladder —
 *     an MCP server or a subagent left in the `claude` group;
 *  2. every recorded descendant that is still alive with the SAME start time,
 *     now ORPHANED (its parent is pid 1) and a TEST RUNNER
 *     (`testRunnerCommand`) is ended through the ladder with its group.
 *
 * The rule's one exception is a session that PARKED — declared
 * `waiting-external`: that is how a phase runs a long suite deliberately
 * detached and waits on its file (the plan's phases 12, 33 and 41), so its
 * jobs are SPARED for `REAP_SPARE_MS`, the longest wait a plan budgets. The
 * sweep (`sweep`, every `REAP_SWEEP_MS`) is the second pass: an orphan of an
 * ended session that is still there — one the end missed, one that came
 * back, one whose spare ran out — is an orphan OLDER THAN ITS SESSION, and is
 * ended the same way. Nothing that started after its session ended is ever
 * touched, and nothing the reaper did not record while the session lived.
 *
 * Every reap is logged `session.reaped`, naming the pids and their commands.
 */

import { readFileSync } from 'node:fs';

import { killLadder } from './signals.ts';
import { processTable, type ProcessRow } from '../pid.ts';
import { log } from '../log.ts';

/** How often a live session's descendants are recorded. */
export const REAP_SAMPLE_MS = 30_000;
/** How often the ended sessions' orphans are looked for again. */
export const REAP_SWEEP_MS = 5 * 60_000;
/** How long a PARKED session's detached jobs are spared — the plan's longest wait budget, and some. */
export const REAP_SPARE_MS = 12 * 60 * 60_000;
/** How long an ended session is remembered at all. */
export const REAP_FORGET_MS = 24 * 60 * 60_000;

/**
 * Is this a test runner's command line? The leads that start a suite and are
 * the class #222 measured spinning: `node --test`, vitest, jest, mocha, bats,
 * pytest, playwright — directly or through `npx`/`pnpm exec`/a `node_modules/.bin` path.
 */
export function testRunnerCommand(command: string): boolean {
  const words = command.trim().split(/\s+/).filter(Boolean);
  const base = (word: string): string => word.split('/').pop() ?? '';
  let i = 0;
  while (i < words.length && (WRAPPERS.has(base(words[i]!)) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!) || words[i]!.startsWith('-'))) i++;
  const program = base(words[i] ?? '');
  const rest = words.slice(i + 1);
  const script = rest.find((word) => !word.startsWith('-')) ?? '';
  if (TEST_RUNNERS.has(program)) return true;
  if (/^node\d*$/.test(program)) {
    return rest.some((word) => word === '--test' || word.startsWith('--test='))
      || RUNNER_MODULE.test(script) || TEST_RUNNERS.has(base(script).replace(/\.[cm]?js$/, ''));
  }
  if (/^python\d*(\.\d+)?$/.test(program)) return rest[rest.indexOf('-m') + 1] === 'pytest' && rest.includes('-m');
  if (program === 'bash' || program === 'sh') return TEST_RUNNERS.has(base(script));
  return false;
}

const TEST_RUNNERS = new Set(['vitest', 'jest', 'mocha', 'bats', 'pytest', 'py.test', 'playwright', 'ava']);
/** Words that launch the program after them. */
const WRAPPERS = new Set(['npx', 'pnpm', 'exec', 'yarn', 'bunx', 'env', 'nice', 'nohup', 'time']);
/** A runner's own entry module, run by node. */
const RUNNER_MODULE = /\/node_modules\/(?:vitest|jest|jest-cli|mocha|@playwright\/test|playwright|ava)\//;

/** Every descendant of `leader` in a process table, by parent links. */
export function descendantsOf(rows: readonly ProcessRow[], leader: number): ProcessRow[] {
  const children = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    const list = children.get(row.ppid);
    if (list) list.push(row);
    else children.set(row.ppid, [row]);
  }
  const out: ProcessRow[] = [];
  const queue = [leader];
  const seen = new Set<number>([leader]);
  while (queue.length) {
    const pid = queue.shift()!;
    for (const child of children.get(pid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      out.push(child);
      queue.push(child.pid);
    }
  }
  return out;
}

/** A descendant as recorded: its identity and what it was. */
type Seen = { startedMs: number | null; command: string };

type Tracked = {
  leader: number;
  sessionId?: string;
  slug?: string;
  phase?: number | null;
  startedAt: number;
  endedAt?: number;
  /** Spared until — a parked session's detached jobs. */
  spareUntil?: number;
  seen: Map<number, Seen>;
};

/** What one reap ended. */
export type Reaped = { pid: number; command: string; ending: string };

/**
 * The orphans of an ended session in a process table: recorded descendants
 * still alive with the same start time, parented by pid 1, started before the
 * session ended, that ARE a test runner or hold one below them — the shell a
 * `bash -c "node --test …"` left is the orphan, and the suite is its child.
 * Pure — the rule, without the processes.
 */
export function orphansOf(rows: readonly ProcessRow[], seen: ReadonlyMap<number, Seen>, endedAt: number): ProcessRow[] {
  const same = (row: ProcessRow): boolean => {
    const was = seen.get(row.pid);
    if (!was) return false;
    if (was.startedMs !== null && row.startedMs !== null && Math.abs(was.startedMs - row.startedMs) > 1_000) return false;
    return row.startedMs === null || row.startedMs <= endedAt;
  };
  return rows.filter((row) => row.ppid === 1 && same(row)
    && (testRunnerCommand(row.command) || descendantsOf(rows, row.pid).some((below) => same(below) && testRunnerCommand(below.command))));
}

export type ReaperDeps = {
  table?: () => Promise<ProcessRow[] | null>;
  /** Ends one process and its group; the ladder with no interrupt rung by default. */
  end?: (pid: number) => Promise<string>;
  now?: () => number;
};

/** The reaper. One per process: every session this console spawns, in one table read. */
export class SessionReaper {
  private readonly sessions = new Map<number, Tracked>();
  private timer: NodeJS.Timeout | null = null;
  private lastSweep = 0;
  private readonly deps: ReaperDeps;

  constructor(deps: ReaperDeps = {}) {
    this.deps = deps;
  }

  private now(): number { return this.deps.now?.() ?? Date.now(); }

  private table(): Promise<ProcessRow[] | null> {
    return (this.deps.table ?? processTable)().catch(() => null);
  }

  private end(pid: number): Promise<string> {
    return (this.deps.end ?? ((id: number) => killLadder(id, { interrupt: false, killAfterMs: 5_000 })))(pid);
  }

  /** A session's leader is up: record its descendants from now on. */
  begin(leader: number, facts: { sessionId?: string; slug?: string; phase?: number | null } = {}): void {
    if (!Number.isInteger(leader) || leader <= 1) return;
    this.sessions.set(leader, { leader, ...facts, startedAt: this.now(), seen: new Map() });
    this.arm();
  }

  /** Record every live session's descendants now. */
  async observe(rows?: readonly ProcessRow[] | null): Promise<void> {
    const live = [...this.sessions.values()].filter((session) => session.endedAt === undefined);
    if (!live.length) return;
    const table = rows ?? await this.table();
    if (!table) return;
    for (const session of live) {
      for (const row of descendantsOf(table, session.leader)) {
        if (!session.seen.has(row.pid)) session.seen.set(row.pid, { startedMs: row.startedMs, command: row.command });
      }
    }
  }

  /**
   * The session's leader has exited: end what is left of its group, and its
   * orphaned test runners unless it parked (`spare`). Answers what was ended.
   */
  async ended(leader: number, opts: { spare?: boolean } = {}): Promise<Reaped[]> {
    const session = this.sessions.get(leader);
    if (!session) return [];
    session.endedAt = this.now();
    if (opts.spare) session.spareUntil = session.endedAt + REAP_SPARE_MS;
    const reaped: Reaped[] = [];
    const table = await this.table();
    // The leader's own group — whatever stayed in the `claude` group.
    const members = (table ?? []).filter((row) => row.pgid === leader && row.pid !== leader);
    if (members.length) {
      const ending = await this.end(leader);
      for (const row of members) reaped.push({ pid: row.pid, command: row.command.slice(0, 200), ending });
    }
    if (!opts.spare && table) reaped.push(...await this.reapOrphans(session, table));
    this.report(session, reaped, 'ended');
    return reaped;
  }

  /** The second pass: orphans of ended sessions still there, older than their session. */
  async sweep(): Promise<Reaped[]> {
    const now = this.now();
    this.lastSweep = now;
    for (const [leader, session] of this.sessions) {
      if (session.endedAt !== undefined && now - session.endedAt > REAP_FORGET_MS) this.sessions.delete(leader);
    }
    const due = [...this.sessions.values()].filter((session) => session.endedAt !== undefined && !(session.spareUntil && session.spareUntil > now));
    if (!due.length) return [];
    const table = await this.table();
    if (!table) return [];
    const all: Reaped[] = [];
    for (const session of due) {
      const reaped = await this.reapOrphans(session, table);
      this.report(session, reaped, 'sweep');
      all.push(...reaped);
    }
    return all;
  }

  private async reapOrphans(session: Tracked, table: readonly ProcessRow[]): Promise<Reaped[]> {
    const out: Reaped[] = [];
    for (const row of orphansOf(table, session.seen, session.endedAt ?? this.now())) {
      const ending = await this.end(row.pid);
      session.seen.delete(row.pid);
      out.push({ pid: row.pid, command: row.command.slice(0, 200), ending });
    }
    return out;
  }

  private report(session: Tracked, reaped: readonly Reaped[], when: 'ended' | 'sweep'): void {
    if (!reaped.length) return;
    log.warn('session.reaped', {
      when, leader: session.leader,
      ...(session.sessionId ? { sessionId: session.sessionId } : {}),
      ...(session.slug ? { slug: session.slug } : {}),
      ...(session.phase !== undefined && session.phase !== null ? { phase: session.phase } : {}),
      pids: reaped.map((row) => row.pid), commands: reaped.map((row) => row.command), endings: reaped.map((row) => row.ending),
    });
  }

  /** Keep sampling while anything is tracked; sweep on the slower clock. */
  private arm(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void (async () => {
        await this.observe();
        if (this.now() - this.lastSweep >= REAP_SWEEP_MS) await this.sweep();
        if (!this.sessions.size) this.stop();
      })().catch((error) => log.warn('session.reap-failed', { error: String(error) }));
    }, REAP_SAMPLE_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** What is tracked — for a test, and for nothing else. */
  tracked(leader: number): ReadonlyMap<number, Seen> | undefined {
    return this.sessions.get(leader)?.seen;
  }
}

/**
 * Did the session that wrote this outcome file PARK — declare
 * `waiting-external`, the shape of a deliberately detached job waited on?
 * Read at the session's close, before the runner consumes the file. Anything
 * unreadable is "no": the rule's default is the reap.
 */
export function parkedOutcome(file: string | undefined): boolean {
  if (!file) return false;
  try {
    const outcome = JSON.parse(readFileSync(file, 'utf8')) as { status?: unknown };
    return outcome?.status === 'waiting-external';
  } catch {
    return false;
  }
}

/** The process's one reaper. */
export const sessionReaper = new SessionReaper();
