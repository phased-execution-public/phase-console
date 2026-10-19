/**
 * What the machine is doing, read as it is (one-pool phase 26, #243 #223 #327).
 *
 * Three facts, each a thing the guard was blind to:
 *
 *  - **CPU busy over 30 s.** The 5-minute load average was the guard's only
 *    input, and on macOS it counts every runnable and short-lived process: it
 *    read 36 while 71 % of a 14-core machine was idle (#243), and it lagged a
 *    burst of three suites by the whole five minutes that took the load to
 *    146 (#223). `os.cpus()` is macOS's `host_processor_info` (and Linux's
 *    `/proc/stat`): every core's cumulative user, nice, sys, irq and idle
 *    ticks. Two samples' difference is the share of the machine that was busy
 *    between them, so the guard sees a burst within one window, and it sees
 *    every process on the machine — an in-turn suite, a pre-push hook, another
 *    console's lane — because it reads the cores, not this console's children.
 *    The average is still read, as the reading's CEILING (`loadReading`).
 *
 *  - **The heavy-job budget.** A heavy job — a full test suite, a build, a
 *    `verify:local` — run by any console's baseline or §Verification takes a
 *    token under `<stateHome>/fleet/jobs/` for as long as it runs, the same
 *    shape as the machine's lane tokens (`fleet/lanes/`). Every console reads
 *    every console's tokens, so two instances on one laptop share one budget
 *    (`heavyJobBudget`) instead of each believing it is alone (#223 ask 3). A
 *    token lapses with the process that wrote it.
 *
 *  - **Which commands are heavy.** `heavyCommand` — the leads that start a
 *    suite or a build. A `grep` over a handoff or a `gh issue list` is not
 *    scheduled; it costs nothing to run beside anything.
 */

import { cpus } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { stateHome } from '../shared/instances.mjs';
import { pidAlive as processAlive } from './pid.ts';
import { CPU_WINDOW_MS } from '../shared/orchestration-model.js';

/** One sample of every core's cumulative ticks: the busy ones and all of them. */
export type CpuSample = { at: number; busy: number; total: number };

/** How often the sampler keeps its window fed while anything reads it. */
export const CPU_SAMPLE_MS = 5_000;

/** The samples kept: a little more than the window, so its far edge always has one. */
const CPU_SAMPLES_KEPT = Math.ceil(CPU_WINDOW_MS / CPU_SAMPLE_MS) + 4;

/**
 * Every core's ticks, summed: busy is user + nice + sys + irq, total adds idle.
 * @param list `os.cpus()`, or a recorded list in a test.
 */
export function cpuTicks(list: ReadonlyArray<{ times: { user: number; nice: number; sys: number; idle: number; irq: number } }>): { busy: number; total: number } {
  let busy = 0;
  let total = 0;
  for (const cpu of list) {
    const t = cpu.times;
    const used = (t.user || 0) + (t.nice || 0) + (t.sys || 0) + (t.irq || 0);
    busy += used;
    total += used + (t.idle || 0);
  }
  return { busy, total };
}

/**
 * The share of the machine busy over the last `windowMs` of `samples` (oldest
 * first): the difference between the newest sample and the newest one at least
 * `windowMs` older — or the oldest there is, when the history is younger than
 * the window. Null with fewer than two samples, or ticks that did not move.
 */
export function cpuBusyOver(samples: readonly CpuSample[], windowMs: number = CPU_WINDOW_MS): number | null {
  if (samples.length < 2) return null;
  const last = samples[samples.length - 1]!;
  let base = samples[0]!;
  for (const sample of samples) {
    if (last.at - sample.at >= windowMs) base = sample;
    else break;
  }
  const total = last.total - base.total;
  const busy = last.busy - base.busy;
  if (!(total > 0) || busy < 0) return null;
  return Math.min(1, busy / total);
}

/**
 * The CPU-busy sampler: a ring of samples a timer keeps fed (unref'd, so it
 * never holds a process open), and a fresh sample taken on every read, so the
 * window's near edge is always now.
 */
export class CpuSampler {
  private readonly samples: CpuSample[] = [];
  private timer: NodeJS.Timeout | null = null;
  private readonly read: () => { busy: number; total: number };
  private readonly now: () => number;
  private readonly intervalMs: number;

  constructor(opts: { read?: () => { busy: number; total: number }; now?: () => number; intervalMs?: number } = {}) {
    this.read = opts.read ?? (() => cpuTicks(cpus()));
    this.now = opts.now ?? Date.now;
    this.intervalMs = opts.intervalMs ?? CPU_SAMPLE_MS;
  }

  /** Take one sample now. A reading that throws is skipped, never fatal. */
  sample(): void {
    let ticks: { busy: number; total: number };
    try { ticks = this.read(); } catch { return; }
    const at = this.now();
    const last = this.samples[this.samples.length - 1];
    // A read within a second of the last adds nothing but noise.
    if (last && at - last.at < 1_000) return;
    this.samples.push({ at, ...ticks });
    if (this.samples.length > CPU_SAMPLES_KEPT) this.samples.splice(0, this.samples.length - CPU_SAMPLES_KEPT);
  }

  /** The busy share over the window, now. Starts the feeding timer on first use. */
  busy(): number | null {
    this.start();
    this.sample();
    return cpuBusyOver(this.samples);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sample(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/** The process's one sampler — every reading on the machine is the same machine. */
let shared: CpuSampler | null = null;

/** The CPU-busy share over the last 30 s, or null before two samples exist. */
export function cpuBusyNow(): number | null {
  shared ??= new CpuSampler();
  return shared.busy();
}

/**
 * Is this §Verification command a HEAVY job — one that runs a suite or a build
 * and so takes a seat in the heavy-job budget (#327)? Read from its leads: any
 * `&&`/`;`/`|` part whose first word (after `env`-style assignments and the
 * `npm --prefix <dir>` shape) starts a test runner, a build or a gate.
 */
export function heavyCommand(command: string): boolean {
  for (const part of command.split(/&&|\|\||;|\|/)) {
    const words = part.trim().replace(/^\(+/, '').split(/\s+/).filter(Boolean);
    while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) words.shift();
    if (words[0] === 'env' || words[0] === 'nice' || words[0] === 'time') words.shift();
    while (words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!) || /^-/.test(words[0]!))) words.shift();
    const [lead, ...rest] = words;
    if (!lead) continue;
    const base = lead.split('/').pop()!;
    if (HEAVY_LEADS.has(base)) return true;
    if (base === 'node' && rest.some((word) => word === '--test' || word.startsWith('--test='))) return true;
    if (base === 'bash' || base === 'sh') {
      const script = rest.find((word) => !word.startsWith('-'));
      if (script && HEAVY_SCRIPTS.test(script)) return true;
    }
    if (PACKAGE_MANAGERS.has(base)) {
      const args = rest.filter((word, index) => !word.startsWith('-') && !(index > 0 && /^--?(prefix|dir|filter|cwd|C)$/.test(rest[index - 1]!)));
      const verb = args[0] === 'run' || args[0] === 'run-script' ? args[1] : args[0];
      if (verb && HEAVY_SCRIPT_NAMES.test(verb)) return true;
    }
    if (base === 'task' || base === 'make') {
      const target = rest.find((word) => !word.startsWith('-'));
      if (target && HEAVY_SCRIPT_NAMES.test(target)) return true;
    }
  }
  return false;
}

/** Leads that are a suite or a build by themselves. */
const HEAVY_LEADS = new Set([
  'vitest', 'jest', 'pytest', 'bats', 'playwright', 'tsc', 'cargo', 'go', 'mvn', 'gradle', 'xcodebuild', 'tox',
]);
/** `npm`-shaped runners, whose script name decides. */
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'npx']);
/** A script or target name that runs a suite, a build, a typecheck or a gate. */
const HEAVY_SCRIPT_NAMES = /^(test|tests|t|ci|build|verify|check|lint|typecheck|e2e|gates?)(?:[:._-]|$)|^(vitest|jest|playwright|tsc)$/;
/** A script file that runs a suite or the gates. */
const HEAVY_SCRIPTS = /(?:^|\/)(run-tests|gates|test|tests|verify[^/]*|rehearse-[^/]*)\.sh$/;

/* ------------------------------------------------------------------ *
 * The machine's heavy-job tokens (#327, #223 ask 3)
 * ------------------------------------------------------------------ */

/** One heavy job running on the machine, as its token records it. */
export type HeavyJobToken = {
  id: string;
  instance: string;
  slug: string;
  phase: number | null;
  runId?: string;
  purpose: string;
  command: string;
  /** The console process that holds it — the token lapses with it. */
  pid: number;
  at: string;
  file: string;
};

/** What the scheduler needs to share the budget across the machine — `MachineJobs`, or a test double. */
export type SchedulerJobs = {
  /** Every heavy job running on the machine, this console's included. */
  running(): HeavyJobToken[];
  /** Take a seat for this job, or be told who holds them all. */
  acquire(job: Omit<HeavyJobToken, 'pid' | 'at' | 'file'>, budget: number): { ok: boolean; holders: HeavyJobToken[] };
  release(id: string): void;
};

/** Where every console's running heavy jobs are recorded, one file each. */
export function heavyJobsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(stateHome(env), 'fleet', 'jobs');
}

/** A token's console is alive — the one probe (`pid.ts`). */
function pidAlive(pid: unknown): boolean {
  return Number.isInteger(pid) && (pid as number) > 1 && processAlive(pid as number);
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
}

/**
 * The machine's heavy jobs over `<stateHome>/fleet/jobs/`. `acquire` is atomic
 * across consoles: it takes a directory lock (`mkdir`, which either makes the
 * directory or fails), re-reads every live token, and writes its own only when
 * the budget has room. A lock older than ten seconds is a dead writer's and is
 * broken. Anything that cannot be written admits — the budget is a courtesy
 * between consoles, and a console that could not write a file must not stop
 * verifying because of it.
 */
export class MachineJobs implements SchedulerJobs {
  private readonly env: NodeJS.ProcessEnv;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.env = env;
  }

  running(): HeavyJobToken[] {
    const dir = heavyJobsDir(this.env);
    let names: string[];
    try { names = readdirSync(dir); } catch { return []; }
    const out: HeavyJobToken[] = [];
    for (const name of names) {
      if (name.startsWith('.') || name.includes('.tmp.')) continue;
      try {
        const token = JSON.parse(readFileSync(join(dir, name), 'utf8')) as HeavyJobToken;
        if (token && typeof token === 'object' && pidAlive(token.pid)) out.push({ ...token, file: name });
      } catch {
        /* half-written or foreign: not a job */
      }
    }
    return out.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  }

  acquire(job: Omit<HeavyJobToken, 'pid' | 'at' | 'file'>, budget: number): { ok: boolean; holders: HeavyJobToken[] } {
    const dir = heavyJobsDir(this.env);
    try { mkdirSync(dir, { recursive: true }); } catch { return { ok: true, holders: [] }; }
    const lock = join(dir, '.lock');
    let locked = false;
    for (let attempt = 0; attempt < 50 && !locked; attempt++) {
      try {
        mkdirSync(lock);
        locked = true;
      } catch {
        try {
          const age = Date.now() - Number(readFileSync(join(lock, 'at'), 'utf8'));
          if (!Number.isFinite(age) || age > 10_000) rmSync(lock, { recursive: true, force: true });
        } catch {
          rmSync(lock, { recursive: true, force: true });
        }
      }
    }
    if (!locked) return { ok: true, holders: [] };
    try {
      try { writeFileSync(join(lock, 'at'), String(Date.now())); } catch { /* the lock is the directory */ }
      // A dead console's token is not a job: reclaimed under the lock.
      for (const name of readdirSync(dir)) {
        if (name.startsWith('.') || name.includes('.tmp.')) continue;
        try {
          const held = JSON.parse(readFileSync(join(dir, name), 'utf8')) as HeavyJobToken;
          if (!pidAlive(held?.pid)) rmSync(join(dir, name), { force: true });
        } catch {
          rmSync(join(dir, name), { force: true });
        }
      }
      const holders = this.running();
      if (holders.length >= Math.max(1, budget)) return { ok: false, holders };
      const file = join(dir, `${safeName(job.instance)}-${safeName(job.id)}.json`);
      const tmp = `${file}.tmp.${process.pid}`;
      try {
        writeFileSync(tmp, `${JSON.stringify({ ...job, pid: process.pid, at: new Date().toISOString() })}\n`, 'utf8');
        renameSync(tmp, file);
      } catch {
        try { rmSync(tmp, { force: true }); } catch { /* the temp file is not the point */ }
      }
      return { ok: true, holders };
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  }

  release(id: string): void {
    const dir = heavyJobsDir(this.env);
    try {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith(`-${safeName(id)}.json`)) continue;
        const held = JSON.parse(readFileSync(join(dir, name), 'utf8')) as HeavyJobToken;
        if (held?.pid === process.pid && held.id === id) rmSync(join(dir, name), { force: true });
      }
    } catch {
      /* a token that could not be removed dies with this process's pid */
    }
  }
}

/** A job id no other console will mint. */
export function heavyJobId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 16);
}
