/**
 * Process lifecycle and health.
 *
 * Two things the console needs once it supervises real work:
 *
 *  - **Degraded state.** An unhandled fault used to end the process. It now
 *    gets recorded here instead, so the server keeps serving and the UI can say
 *    "something broke" rather than the browser silently facing a dead port.
 *  - **Ordered shutdown.** A run in progress must be checkpointed before the
 *    process goes away. Subsystems register a handler; `index.ts` awaits them
 *    with a ceiling so a wedged handler can't block the exit forever.
 *
 * Kept apart from `log.ts` on purpose: that module must stay dependency-free
 * enough to be safe to call from inside a crash handler.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { INSTANCE_STATE_DIR } from './config.ts';
import { log } from './log.ts';
import { STOP_MARKER_NAME } from '../shared/instances.mjs';
import type { ShutdownDurability, ShutdownIntent, ShutdownMode } from '../shared/ops-vocab.js';

/* ------------------------------------------------------------------ *
 * Degraded state
 * ------------------------------------------------------------------ */

export type Degradation = { at: string; kind: string; message: string };

const MAX_KEPT = 20;
const degradations: Degradation[] = [];
let notify: ((state: Degradation) => void) | null = null;

/** Let the service push degradations out over SSE without importing it here. */
export function onDegraded(listener: (state: Degradation) => void): void {
  notify = listener;
}

/** The same fault, over and over, is one fault. */
let last: { key: string; at: number; count: number } | null = null;
const REPEAT_WINDOW_MS = 2_000;

export function markDegraded(kind: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);

  // A fault whose own reporting can re-trigger it — a write to a stderr that no
  // longer exists is the real example — otherwise recurses until something
  // gives. Collapsing repeats is what stops that being fatal rather than merely
  // noisy, so it is a guard and not a tidiness measure.
  const key = `${kind}:${message}`;
  const now = Date.now();
  if (last && last.key === key && now - last.at < REPEAT_WINDOW_MS) {
    last.count++;
    last.at = now;
    return;
  }
  const repeated = last?.key === key ? last.count : 0;
  last = { key, at: now, count: 1 };
  if (repeated > 1) log.warn('degraded.repeated', { kind, message, times: repeated });

  const entry: Degradation = { at: new Date().toISOString(), kind, message };
  degradations.push(entry);
  if (degradations.length > MAX_KEPT) degradations.shift();
  log.error('degraded', { kind, error });
  try { notify?.(entry); } catch { /* a listener must never re-enter the crash path */ }
}

export function degradedState(): { healthy: boolean; recent: Degradation[] } {
  return { healthy: degradations.length === 0, recent: [...degradations] };
}

/** Called once a subsystem has recovered — clears the badge. */
export function clearDegraded(kind: string): void {
  for (let i = degradations.length - 1; i >= 0; i--) {
    if (degradations[i].kind === kind) degradations.splice(i, 1);
  }
}

/* ------------------------------------------------------------------ *
 * Ordered shutdown
 * ------------------------------------------------------------------ */

/**
 * What a drain handler is told about the drain it is part of (SHD-8): WHY the
 * process is going away — a Shut down press, a Restart press, or a signal no
 * request explains — so a checkpoint can say which on the run's own journal
 * instead of naming only a pid and a signal.
 */
export type ShutdownContext = {
  intent: ShutdownIntent;
  /** What asked for it: the press's sentence, or the signal's name. */
  reason: string;
  /** The strength of a Shut down press, when that is what it was. */
  mode?: ShutdownMode;
};

export type ShutdownHandler = (context: ShutdownContext) => Promise<void> | void;

const handlers = new Map<string, ShutdownHandler>();

/** Register cleanup that must finish before the process exits. Idempotent by name. */
export function onShutdown(name: string, handler: ShutdownHandler): void {
  handlers.set(name, handler);
}

export function offShutdown(name: string): void {
  handlers.delete(name);
}

export function hasShutdownWork(): boolean {
  return handlers.size > 0;
}

/**
 * Run every handler, each with its own deadline so one slow subsystem does not
 * eat the whole budget. Resolves once all have settled or timed out; never
 * rejects — a failed cleanup is logged, not thrown, because the alternative is
 * an unhandled rejection during shutdown.
 */
/* ------------------------------------------------------------------ *
 * Restarting on purpose
 * ------------------------------------------------------------------ */

/**
 * Is anything going to start this process again if it exits?
 *
 * The whole reason a Restart button can exist is that under launchd
 * `KeepAlive: true` a clean `exit(0)` is respawned within seconds. Under
 * `./run`, the desktop launcher, or `node server/index.ts` in a terminal there
 * is nothing watching — pressing Restart there would not restart the console,
 * it would *end* it, from a page that then has no server to tell you so.
 *
 * That asymmetry is the entire design constraint, so the answer is checked
 * rather than assumed, and it is checked in the only two ways that are actually
 * evidence:
 *
 *  - launchd stamps the job's label into `XPC_SERVICE_NAME`, and the plist that
 *    label names is readable — so `KeepAlive` is *read*, not hoped for. A job
 *    installed with `KeepAlive: false` is correctly reported as unsupervised.
 *  - systemd sets `INVOCATION_ID` for a unit it started; whether that unit has
 *    `Restart=` cannot be read from inside it, so it is reported as
 *    supervision this process cannot confirm, and the UI says so.
 *
 * `PHASE_CONSOLE_SUPERVISED=1|0` overrides both, for a supervisor nothing here
 * knows about (or a launchd job you want the button to refuse).
 */
export type Supervisor = {
  /** Whether a clean exit is expected to come back. */
  supervised: boolean;
  kind: 'launchd' | 'systemd' | 'declared' | 'none';
  /** One line, shown to a person about to press a button they cannot undo. */
  detail: string;
  /** True when supervision is inferred rather than read. */
  assumed?: boolean;
  /**
   * The stop marker, when a `mode: 'unload'` Shut down left one (SHD-5): this
   * console was stopped on purpose and holds its automation until it is
   * cleared. Read beside the supervisor because both answer "what will bring
   * this console's work back", and a page showing one without the other would
   * promise a comeback the boot is going to refuse.
   */
  stopped?: StopMarker;
};

export function detectSupervisor(
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): Supervisor {
  const found = supervision(env, platform);
  const stopped = readStopMarker();
  return stopped ? { ...found, stopped } : found;
}

function supervision(env: NodeJS.ProcessEnv, platform: string): Supervisor {
  const declared = env.PHASE_CONSOLE_SUPERVISED;
  if (declared === '1') {
    return { supervised: true, kind: 'declared', detail: 'PHASE_CONSOLE_SUPERVISED=1 — you have said something will restart it' };
  }
  if (declared === '0') {
    return { supervised: false, kind: 'declared', detail: 'PHASE_CONSOLE_SUPERVISED=0 — restarting is disabled here' };
  }

  const label = env.XPC_SERVICE_NAME;
  if (platform === 'darwin' && label && label !== '0') {
    const keepAlive = readKeepAlive(label, env);
    if (keepAlive === true) {
      return { supervised: true, kind: 'launchd', detail: `launchd · ${label} · KeepAlive is on, so a clean exit comes straight back` };
    }
    if (keepAlive === false) {
      return {
        supervised: false,
        kind: 'launchd',
        detail: `launchd · ${label} · KeepAlive is off — exiting would stop the console, not restart it`,
      };
    }
    return {
      supervised: true,
      kind: 'launchd',
      assumed: true,
      detail: `launchd · ${label} · its plist could not be read, so KeepAlive is assumed rather than confirmed`,
    };
  }

  const unit = env.PHASE_CONSOLE_UNIT;
  if (env.INVOCATION_ID && unit) {
    const restart = readRestartPolicy(unit, env);
    if (restart === true) {
      return { supervised: true, kind: 'systemd', detail: `systemd · ${unit} · its Restart= brings a clean exit straight back` };
    }
    if (restart === false) {
      return {
        supervised: false,
        kind: 'systemd',
        detail: `systemd · ${unit} · its Restart= does not cover a clean exit — exiting would stop the console, not restart it`,
      };
    }
    return {
      supervised: true,
      kind: 'systemd',
      assumed: true,
      detail: `systemd · ${unit} · its unit file could not be read, so Restart= is assumed rather than confirmed`,
    };
  }

  if (env.INVOCATION_ID) {
    return {
      supervised: true,
      kind: 'systemd',
      assumed: true,
      detail: 'systemd started this unit; whether it has Restart= set cannot be read from inside it',
    };
  }

  return {
    supervised: false,
    kind: 'none',
    detail: 'nothing is supervising this process — it was started from a terminal'
      + ', '
      + 'so exiting would leave no console running',
  };
}

/**
 * `true`/`false` when the unit file could be read, `null` when it could not.
 * Only `always` and `on-success` bring a *clean* exit back — which is the
 * question the Restart button is asking. Last assignment wins, as in systemd.
 */
function readRestartPolicy(unit: string, env: NodeJS.ProcessEnv): boolean | null {
  const home = env.HOME ?? homedir();
  const base = env.XDG_CONFIG_HOME ?? join(home, '.config');
  let text: string;
  try { text = readFileSync(join(base, 'systemd', 'user', unit), 'utf8'); } catch { return null; }
  const assignments = [...text.matchAll(/^\s*Restart\s*=\s*(\S*)/gm)];
  const value = assignments.at(-1)?.[1] ?? 'no';
  return value === 'always' || value === 'on-success';
}

/** `true`/`false` when the plist could be read, `null` when it could not. */
function readKeepAlive(label: string, env: NodeJS.ProcessEnv): boolean | null {
  const home = env.HOME ?? homedir();
  for (const path of [
    join(home, 'Library', 'LaunchAgents', `${label}.plist`),
    join('/Library', 'LaunchAgents', `${label}.plist`),
  ]) {
    let text: string;
    try { text = readFileSync(path, 'utf8'); } catch { continue; }
    // KeepAlive may be <true/>, <false/>, or a dict of conditions — a dict is
    // still "something will bring it back", which is the question being asked.
    const at = text.indexOf('<key>KeepAlive</key>');
    if (at < 0) return false;
    const after = text.slice(at + '<key>KeepAlive</key>'.length, at + 200);
    if (/^\s*<false\s*\/>/.test(after)) return false;
    return true;
  }
  return null;
}

/**
 * How the API asks the process to go away and come back.
 *
 * `index.ts` owns `shutdown()` — it holds the server handle and the drain
 * budget — so it registers the verb here rather than exporting a function the
 * API would have to import from the entry point.
 */
let restarter: ((reason: string) => void) | null = null;

export function onRestartRequest(handler: (reason: string) => void): void {
  restarter = handler;
}

export function requestRestart(reason: string): boolean {
  if (!restarter) return false;
  try { restarter(reason); } catch (error) { log.error('restart.failed', { reason, error }); return false; }
  return true;
}

/** The state a restart is being asked for from, for the API and the UI alike. */
export function supervisor(): Supervisor {
  return detectSupervisor();
}

/* ------------------------------------------------------------------ *
 * Stopping on purpose
 * ------------------------------------------------------------------ */

/**
 * How this process is actually stopped — which is not the same question as how
 * it is restarted, and is the reason there was no off switch for so long.
 *
 * Two strengths since zero-touch phase 16 (SHD-2, SHD-5), because one verb was
 * doing two jobs and promising a third:
 *
 *  - **`exit`** — the default. The process drains and exits. Under launchd
 *    `KeepAlive` (or systemd `Restart=`) the supervisor brings it straight back,
 *    so this stops the WORK — every run checkpoints and resumes — and not the
 *    console; nothing supervising means it stays stopped.
 *  - **`unload`** — the explicit "stay off". The unit is DISABLED and unloaded
 *    (`launchctl disable` + `bootout`, or `systemctl --user disable --now`) and
 *    the stop marker is written, so neither the next login nor a hand-started
 *    process picks the automation back up until somebody clears it. The old
 *    Shut down was a bare `bootout` that promised "it stays off" and came back
 *    at the next login with the plist still on disk.
 *
 * `unload` needs a unit this process can name; with none there is nothing to
 * unload (`exit` already stops it), and the plan is `null`.
 *
 * Pure, so the decision can be asserted without spawning anything.
 */
export type ExitPlan = {
  via: 'exit';
  mode: 'exit';
  durability: Exclude<ShutdownDurability, 'disabled'>;
  detail: string;
};

export type UnloadPlan = {
  via: 'launchctl' | 'systemctl';
  mode: 'unload';
  file: string;
  /** Every command, in order — each is `file` + these args. The last one ends this process. */
  steps: string[][];
  /** The step that ends the process (kept for `bootout`, which runs exactly this). */
  args: string[];
  label: string;
  durability: 'disabled';
  /** A stop marker is written before any step runs. */
  marker: true;
  /** The command that undoes it — the last thing this console will tell you. */
  resurrect: string;
  detail: string;
};

export type StopPlan = ExitPlan | UnloadPlan;

export function stopPlan(sup?: Supervisor, env?: NodeJS.ProcessEnv, uid?: number | null, mode?: 'exit'): ExitPlan;
export function stopPlan(sup: Supervisor, env: NodeJS.ProcessEnv, uid: number | null, mode: 'unload'): UnloadPlan | null;
export function stopPlan(sup: Supervisor, env: NodeJS.ProcessEnv, uid: number | null, mode: ShutdownMode): StopPlan | null;
export function stopPlan(
  sup: Supervisor = detectSupervisor(),
  env: NodeJS.ProcessEnv = process.env,
  // `null` rather than `undefined` for "this platform has no uid": passing
  // `undefined` to a defaulted parameter re-triggers the default, so the
  // no-uid case would be untestable — and it is a real case (Windows).
  uid: number | null = process.getuid?.() ?? null,
  mode: ShutdownMode = 'exit',
): StopPlan | null {
  if (mode === 'unload') return unloadPlan(sup, env, uid);
  if (sup.supervised) {
    return {
      via: 'exit',
      mode: 'exit',
      durability: 'returns',
      detail: sup.kind === 'launchd' || (sup.kind === 'systemd' && !sup.assumed)
        ? `${sup.detail} — it exits and comes straight back; every run checkpoints and resumes`
        : `${sup.detail} — this console cannot name that supervisor, so it exits and may be brought back`,
    };
  }
  if (sup.kind === 'launchd' || sup.kind === 'systemd') {
    return {
      via: 'exit',
      mode: 'exit',
      durability: 'until-login',
      detail: `${sup.detail} — it stays stopped until the next login starts the unit again`,
    };
  }
  return { via: 'exit', mode: 'exit', durability: 'stays-off', detail: 'nothing is supervising this process, so exiting stops it' };
}

function unloadPlan(sup: Supervisor, env: NodeJS.ProcessEnv, uid: number | null): UnloadPlan | null {
  const label = env.XPC_SERVICE_NAME;
  if (sup.kind === 'launchd' && label && label !== '0' && uid != null) {
    const target = `gui/${uid}/${label}`;
    return {
      via: 'launchctl',
      mode: 'unload',
      file: 'launchctl',
      // `disable` FIRST, and synchronously: it only writes launchd's override
      // database, and it has to land before `bootout` — whose SIGTERM is what
      // ends this process. `bootout` on the service target, not `stop`: `stop`
      // under KeepAlive is a restart with extra steps.
      steps: [['disable', target], ['bootout', target]],
      args: ['bootout', target],
      label,
      durability: 'disabled',
      marker: true,
      resurrect: `launchctl enable gui/$(id -u)/${label} && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/${label}.plist`
        + '',
      detail: `launchd · ${label} · the job is unloaded and disabled and a stop marker holds its automation, so it stays off — a login does not bring it back`,
    };
  }
  const unit = env.PHASE_CONSOLE_UNIT;
  if (sup.kind === 'systemd' && unit) {
    return {
      via: 'systemctl',
      mode: 'unload',
      file: 'systemctl',
      // `disable --now` is both halves in one command: the unit stops (its
      // SIGTERM ends this process) and no longer starts at login.
      steps: [['--user', 'disable', '--now', unit]],
      args: ['--user', 'disable', '--now', unit],
      label: unit,
      durability: 'disabled',
      marker: true,
      resurrect: `systemctl --user enable --now ${unit}`
        + '',
      detail: `systemd · ${unit} · the unit is stopped and disabled and a stop marker holds its automation, so it stays off — a login does not bring it back`,
    };
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * The stop marker
 * ------------------------------------------------------------------ */

/**
 * "This console was stopped on purpose, and meant it" — on disk (SHD-5).
 *
 * `INSTANCE_STATE_DIR/stopped-by-console.json`, written by a `mode: 'unload'`
 * Shut down BEFORE anything is unloaded. A boot that finds it holds its
 * automation — `readoptQueued` re-adopts nothing, converge converges nothing —
 * and says why, until an operator clears it: `phase-console start` removes the
 * file, and so does Settings' release. The unit being disabled keeps the
 * process from coming back; the marker keeps a process that comes back anyway
 * (a hand-run `launchctl bootstrap`, a foreground start) from picking the work
 * back up behind the operator's back.
 *
 * Tolerant in one direction only, like the freeze marker: every unreadable
 * shape answers "not stopped". A console that wrongly believes itself stopped
 * does nothing, silently; one that wrongly believes itself released starts work
 * a person can see and stop.
 */
export type StopMarker = {
  at: string;
  by: string;
  via?: string;
  origin?: string;
  remoteUser?: string | null;
  mode: 'unload';
  durability: ShutdownDurability;
  label?: string;
  resurrect?: string;
};

export const STOP_MARKER_FILE = join(INSTANCE_STATE_DIR, STOP_MARKER_NAME);

export function readStopMarker(file: string = STOP_MARKER_FILE): StopMarker | null {
  let raw: string;
  try { raw = readFileSync(file, 'utf8'); } catch { return null; }
  try {
    const parsed = JSON.parse(raw) as Partial<StopMarker> | null;
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.at !== 'string' || !Number.isFinite(Date.parse(parsed.at))) return null;
    return {
      ...parsed,
      at: parsed.at,
      by: typeof parsed.by === 'string' && parsed.by ? parsed.by : 'console',
      mode: 'unload',
      durability: parsed.durability ?? 'disabled',
    } as StopMarker;
  } catch {
    log.warn('shutdown.marker-unreadable', { file });
    return null;
  }
}

/** Write the marker atomically; returns what the next reader will see. */
export function writeStopMarker(marker: Omit<StopMarker, 'at' | 'mode'> & { at?: string }, file: string = STOP_MARKER_FILE): StopMarker {
  const record: StopMarker = { ...marker, at: marker.at ?? new Date().toISOString(), mode: 'unload' };
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
  return record;
}

/**
 * Remove the marker; returns the marker that stood, or null. Throws when the
 * file is still there afterwards — a release that could not happen must not
 * leave a process believing it released while the next boot holds again.
 */
export function clearStopMarker(file: string = STOP_MARKER_FILE): StopMarker | null {
  const was = readStopMarker(file);
  try { rmSync(file, { force: true }); } catch (error) { log.warn('shutdown.marker-clear-failed', { file, error }); }
  if (readStopMarker(file)) throw new Error(`the stop marker could not be removed (${file}) — the console still holds its automation`);
  return was;
}

/**
 * The narrow slice of `child_process.spawn` this needs, so a test can pass a fake.
 *
 * `cwd` and `pid` joined it with the self-re-exec: `reexec` starts the
 * successor in the console's own directory and journals the pid it got back.
 * The type said neither, so `typecheck:server` had been red since that landed
 * — a declared slice narrower than its only call site is a contract nothing
 * can check.
 */
export type Spawner = (
  file: string,
  args: string[],
  options: { cwd?: string; detached: boolean; stdio: 'ignore' },
) => { unref(): void; pid?: number };

/**
 * Hand the stop order to the supervisor and walk away.
 *
 * Detached with no stdio on purpose: the command outlives this process by
 * design — it is the thing that ends it — so it must not be a child whose
 * parent dying takes it with it.
 */
export function bootout(plan: StopPlan, spawn: Spawner): boolean {
  if (plan.via === 'exit') return false;
  try {
    spawn(plan.file, plan.args, { detached: true, stdio: 'ignore' }).unref();
    log.warn('shutdown.bootout', { label: plan.label, args: plan.args });
    return true;
  } catch (error) {
    log.error('shutdown.bootout.failed', { label: plan.label, error });
    return false;
  }
}

/** The narrow slice of `child_process.spawnSync` `unload` needs — a test passes a fake. */
export type SyncRunner = (file: string, args: string[], options: { timeout: number; stdio: 'ignore' }) => { status: number | null; error?: Error };

/**
 * Carry out an `unload` plan: every step but the last synchronously (they only
 * write the supervisor's own records, and each has to land before the step
 * that ends this process), then the last one detached through `bootout`.
 * Returns what was achieved — `disabled` is false when a disable step failed,
 * and the marker the caller already wrote is then the only thing holding the
 * boot, which the log says (`shutdown.disabled`).
 */
export function unload(plan: UnloadPlan, spawn: Spawner, run: SyncRunner): { disabled: boolean; spawned: boolean } {
  let disabled = true;
  for (const args of plan.steps.slice(0, -1)) {
    let ok = false;
    try {
      const result = run(plan.file, args, { timeout: 5_000, stdio: 'ignore' });
      ok = !result.error && result.status === 0;
    } catch { ok = false; }
    disabled &&= ok;
  }
  // systemd's single `disable --now` step both disables and stops, so it has
  // nothing to run ahead of the step that ends the process.
  const spawned = bootout({ ...plan, args: plan.steps.at(-1) ?? plan.args }, spawn);
  log.warn('shutdown.disabled', { label: plan.label, disabled, spawned, steps: plan.steps.length });
  return { disabled, spawned };
}

/**
 * Disable this console's own unit WITHOUT stopping it — what spending an
 * `autostart: 'once'` means (FLT-9): this boot was the one start the profile
 * granted, so the next login must not start it again. launchd's `disable`
 * writes only its override database; systemd's `disable` (no `--now`) only
 * removes the login link. Null when there is no unit this process can name.
 */
export function disableOwnUnit(
  run: SyncRunner,
  sup: Supervisor = detectSupervisor(),
  env: NodeJS.ProcessEnv = process.env,
  uid: number | null = process.getuid?.() ?? null,
): { label: string; ok: boolean } | null {
  const plan = stopPlan(sup, env, uid, 'unload');
  if (!plan) return null;
  const args = plan.via === 'launchctl' ? plan.steps[0] : ['--user', 'disable', plan.label];
  let ok = false;
  try {
    const result = run(plan.file, args, { timeout: 5_000, stdio: 'ignore' });
    ok = !result.error && result.status === 0;
  } catch { ok = false; }
  return { label: plan.label, ok };
}

/**
 * The Shut-down button's other half, registered by `index.ts` for the same
 * reason `onRestartRequest` is: `shutdown()` closes over the server handle and
 * the drain budget.
 */
/** What a Shut down press asks for beyond its sentence — the strength it chose. */
export type ShutdownRequest = { mode: ShutdownMode };

let stopper: ((reason: string, request: ShutdownRequest) => void) | null = null;

export function onShutdownRequest(handler: (reason: string, request: ShutdownRequest) => void): void {
  stopper = handler;
}

export function requestShutdown(reason: string, request: ShutdownRequest = { mode: 'exit' }): boolean {
  if (!stopper) return false;
  try { stopper(reason, request); } catch (error) { log.error('shutdown.failed', { reason, error }); return false; }
  return true;
}

export async function runShutdownHandlers(
  perHandlerMs: number,
  context: ShutdownContext = { intent: 'signal', reason: 'unknown' },
): Promise<void> {
  const pending = [...handlers.entries()];
  handlers.clear();

  await Promise.all(pending.map(async ([name, handler]) => {
    const started = Date.now();
    try {
      await Promise.race([
        Promise.resolve(handler(context)),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error(`shutdown handler "${name}" exceeded ${perHandlerMs}ms`)), perHandlerMs).unref()),
      ]);
      log.info('shutdown.handler', { name, ms: Date.now() - started });
    } catch (error) {
      log.error('shutdown.handler.failed', { name, ms: Date.now() - started, error });
    }
  }));
}

/* ---------------------------------------------------------------- *
 * Restarting where nothing supervises
 * ---------------------------------------------------------------- */

/**
 * What a self-restart runs: this process's own executable and its own argv,
 * in its own cwd — every `--allow-*` flag, `--port`, `--remote`, exactly as
 * the terminal or the desktop launcher started it. Nothing is composed and
 * nothing is looked up, so the successor can never disagree with the console
 * that spawned it.
 *
 * Pure, so a test can assert the command without starting anything.
 */
export type SelfRestartPlan = { file: string; args: string[]; cwd: string; command: string };

export function selfRestartPlan(
  argv: readonly string[] = process.argv,
  execPath: string = process.execPath,
  cwd: string = process.cwd(),
): SelfRestartPlan {
  const args = argv.slice(1);
  return { file: execPath, args, cwd, command: [basename(execPath), ...args].join(' ') };
}

/**
 * Whether Restart may proceed, and how.
 *
 * Under launchd `KeepAlive` or systemd `Restart=` the supervisor brings the
 * console back, so a clean exit IS the restart. Where nothing supervises —
 * `./run`, `./start`, the desktop launcher, a bare `node server/index.ts` —
 * the console used to refuse, because exiting there would have ended it.
 * It now starts its own successor instead (`reexec`, from `selfRestartPlan`)
 * and only then exits: the same arguments, the same capabilities.
 *
 * The one refusal left is a supervisor that is present but declared not to
 * restart (`PHASE_CONSOLE_SUPERVISED=0`, a unit with `KeepAlive` off): there
 * the process is somebody else's job to run, and a successor it spawned
 * itself would be an orphan the unit no longer owns.
 */
export function restartVerdict(sup: Supervisor): { ok: true; selfRestart: boolean } | { ok: false; reason: string } {
  if (sup.supervised) return { ok: true, selfRestart: false };
  if (sup.kind === 'none') return { ok: true, selfRestart: true };
  return {
    ok: false,
    reason: `${sup.detail}. Stopping it here would leave nothing serving this page — `
      + 'start it again from a terminal'
      + '.',
  };
}

/**
 * Start the successor. Detached and with its stdio ignored, so it survives
 * this process exiting and the terminal that started it closing; `unref` so
 * the handle cannot keep THIS process alive past its `exit(0)`.
 *
 * Called after the listener is closed and the drain has run, and before the
 * exit — the successor binds the same port, so the listener must already be
 * gone. Returns whether the spawn call succeeded; the successor's own boot is
 * its own business (and its own log).
 */
export function reexec(plan: SelfRestartPlan, spawn: Spawner): boolean {
  try {
    const child = spawn(plan.file, plan.args, { cwd: plan.cwd, detached: true, stdio: 'ignore' });
    child.unref();
    log.info('restart.reexec', { command: plan.command, pid: child.pid ?? null });
    return true;
  } catch (error) {
    log.error('restart.reexec-failed', { command: plan.command, error: String(error) });
    return false;
  }
}
