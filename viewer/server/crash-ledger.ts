/**
 * What this console knows about its own hard endings.
 *
 * A console that dies without writing an exit record — SIGKILL, a heap limit, a
 * machine losing power — used to leave one `previous-run-crashed` line in a log
 * nobody reads, and launchd's `KeepAlive` with a ten-second throttle brought it
 * straight back. The measured consequence was not one crash: it was a loop.
 * Each boot adopted the surviving `claude` children of the runs the last one
 * was driving, re-parked them `orphaned-session`, and died again five minutes
 * later, so two live autopilot runs were parked by a console that never managed
 * to drive anything.
 *
 * Two facts follow, and this module owns both, along with the marker a boot
 * needs to notice a hard ending at all.
 *
 *   **The ledger.** One line per crashed boot, bounded, on disk, so "has this
 *   happened before" is answerable by the console rather than by a person
 *   reading timestamps in a log. It records where a heap snapshot landed when
 *   one was written, which is the whole point of asking for one.
 *
 *   **The breaker.** Three crashed boots inside ten minutes is not an incident,
 *   it is a loop, and the right response is to stop rather than to try again
 *   faster. That is a boot hold — the same shape the stop marker and
 *   `autostart: false` already produce — and lifting it is a person's press.
 *
 *   **The marker.** A process that is already gone cannot say so, so a console
 *   that owns its port leaves a file on disk for exactly as long as it runs.
 *   One found at boot whose process is gone is a hard ending, whatever the log
 *   did in between (`settleBootMarkers`).
 *
 * Dependency-light on purpose: `service-base.ts` asks it a question at boot and
 * `runner/state.ts` asks it a narrower one on every read, and neither may end
 * up importing the other through here. `pid.ts`, the one process probe, imports
 * nothing of ours.
 */

import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { INSTANCE_STATE_DIR } from './config.ts';
import { log } from './log.ts';
import { processStateAsync } from './pid.ts';

/** How many crashed boots the ledger keeps. */
export const CRASH_LEDGER_MAX = 20;

/** How many crashed boots inside the window make a loop. */
export const CRASH_LOOP_BOOTS = 3;

/** The window that word is measured over. */
export const CRASH_LOOP_WINDOW_MS = 10 * 60_000;

/** One hard ending, as the boot after it saw it. */
export type CrashEntry = {
  /** ISO — when the boot that NOTICED started. The crash itself is shortly before. */
  at: string;
  /** The pid of the console that noticed. */
  pid: number;
  /** Where a near-limit heap snapshot landed, when one was written. */
  snapshot?: string;
};

export function crashLedgerFile(stateDir: string = INSTANCE_STATE_DIR): string {
  return join(stateDir, 'crashes.json');
}

export function readCrashLedger(stateDir: string = INSTANCE_STATE_DIR): CrashEntry[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(crashLedgerFile(stateDir), 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is CrashEntry =>
        Boolean(entry) && typeof entry === 'object'
        && typeof (entry as CrashEntry).at === 'string'
        && typeof (entry as CrashEntry).pid === 'number',
    );
  } catch {
    // No ledger is the normal case and reads as "nothing has crashed".
    return [];
  }
}

/**
 * Record that this boot found a console before it that ended hard — its boot
 * marker still on disk, its process gone (`settleBootMarkers`).
 *
 * Oldest-first, bounded at `CRASH_LEDGER_MAX`: a console in a loop must not
 * also fill a disk, and twenty entries is more history than any diagnosis of a
 * ten-minute window needs.
 */
export function recordCrashedBoot(
  entry: Omit<CrashEntry, 'at' | 'pid'> & Partial<Pick<CrashEntry, 'at' | 'pid'>> = {},
  stateDir: string = INSTANCE_STATE_DIR,
): CrashEntry[] {
  const next: CrashEntry = {
    at: entry.at ?? new Date().toISOString(),
    pid: entry.pid ?? process.pid,
    ...(entry.snapshot ? { snapshot: entry.snapshot } : {}),
  };
  const kept = [...readCrashLedger(stateDir), next].slice(-CRASH_LEDGER_MAX);
  const file = crashLedgerFile(stateDir);
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(kept, null, 2)}\n`);
  } catch (error) {
    // A ledger that cannot be written must not be a console that cannot boot.
    log.warn('crash-ledger.write-failed', { error: String(error) });
  }
  return kept;
}

/**
 * The newest heap snapshot node wrote for this instance, if any.
 *
 * `--heapsnapshot-near-heap-limit=1` writes one file and says nothing about it
 * anywhere a person would look. Naming it on the crash row is the whole reason
 * the flag is worth offering: the next near-limit event should end with
 * somebody opening the snapshot that names the retainer, not with a search.
 */
export function latestHeapSnapshot(stateDir: string = INSTANCE_STATE_DIR): string | null {
  const dir = join(stateDir, 'diag');
  try {
    const newest = readdirSync(dir)
      .filter((name) => name.endsWith('.heapsnapshot'))
      .map((name) => {
        const path = join(dir, name);
        return { path, at: statSync(path).mtimeMs };
      })
      .sort((a, b) => b.at - a.at)[0];
    return newest?.path ?? null;
  } catch {
    return null;
  }
}

/**
 * Is this console in a crash loop right now?
 *
 * Counted over the ledger's own timestamps rather than over uptime, because the
 * question is about the sequence of BOOTS: a console that crashed three times
 * in ten minutes is one that cannot get far enough to be useful, whatever any
 * single life of it managed to do.
 */
export function crashLoop(
  now: number = Date.now(),
  stateDir: string = INSTANCE_STATE_DIR,
): { since: string; boots: number } | null {
  const recent = readCrashLedger(stateDir).filter((entry) => {
    const at = Date.parse(entry.at);
    return Number.isFinite(at) && now - at < CRASH_LOOP_WINDOW_MS;
  });
  if (recent.length < CRASH_LOOP_BOOTS) return null;
  return { since: recent[0].at, boots: recent.length };
}

/* ------------------------------------------------------------------ *
 * The boot marker — how a hard ending is noticed at all
 * ------------------------------------------------------------------ */

/**
 * "This process owns the port" — on disk, one file per boot, for as long as the
 * process runs.
 *
 * The verdict used to be read out of the console's own log: the whole file,
 * walked back at most 400 lines for a `start` with no `exit` after it. A busy
 * console writes ~350 lines an hour, so one that died after an hour or so of
 * uptime — a slow heap exhaustion, say — had already pushed its own `start` out
 * of reach, the answer came back "nothing to conclude", and neither the ledger
 * nor the breaker ever heard of it. The same shared log also carried the
 * start/exit pair a duplicate launch writes when the port refuses it, which
 * read as the clean ending of the console that was still running.
 *
 * So the verdict no longer reads the log. A console writes `boots/<pid>.json`
 * once it OWNS its port — never earlier, because a launch that has not bound yet
 * may be about to be refused, and its ending is not this instance's to count —
 * and removes it where its exit record is written. A marker still on disk whose
 * process is gone is a hard ending, however much was logged after it. A launch
 * that never owned the port wrote none, so it can neither be counted nor mask
 * the ending of the console that did.
 *
 * One file per boot rather than one per instance, so no process ever deletes a
 * marker it did not write: a successor that bound the port while its
 * predecessor was still draining keeps its own, and launches racing over one
 * dead console's marker settle it with a single `unlink`, which exactly one of
 * them wins.
 */
export type BootMarker = {
  pid: number;
  /**
   * ISO — when the process started. Half of its identity: the pid may since
   * have been handed to something else, and the probe compares this against
   * the kernel's own start time to tell.
   */
  startedAt: string;
  /** The port it owned. */
  port: number;
  /** ISO — when it came to own it. */
  at: string;
};

/** When this process started: its own clock, fixed for its whole life. */
const SELF_STARTED_AT = new Date(performance.timeOrigin).toISOString();

/** `<pid>.json` — a half-written `.tmp` beside one is never a marker. */
const MARKER_NAME = /^\d+\.json$/;

export function bootMarkerDir(stateDir: string = INSTANCE_STATE_DIR): string {
  return join(stateDir, 'boots');
}

function bootMarkerFile(pid: number, stateDir: string): string {
  return join(bootMarkerDir(stateDir), `${pid}.json`);
}

function parseBootMarker(raw: string): BootMarker | null {
  try {
    const parsed = JSON.parse(raw) as Partial<BootMarker> | null;
    if (!parsed || typeof parsed !== 'object') return null;
    if (!Number.isInteger(parsed.pid) || (parsed.pid as number) <= 0) return null;
    if (typeof parsed.startedAt !== 'string' || !Number.isFinite(Date.parse(parsed.startedAt))) return null;
    return {
      pid: parsed.pid as number,
      startedAt: parsed.startedAt,
      port: typeof parsed.port === 'number' ? parsed.port : 0,
      at: typeof parsed.at === 'string' ? parsed.at : parsed.startedAt,
    };
  } catch {
    return null;
  }
}

/** The marker files in `dir`, or null when no console has ever written one here. */
function markerNames(dir: string): string[] | null {
  try {
    return readdirSync(dir).filter((name) => MARKER_NAME.test(name)).sort();
  } catch {
    return null;
  }
}

/** Every marker on disk, as the next boot will read them. */
export function readBootMarkers(stateDir: string = INSTANCE_STATE_DIR): BootMarker[] {
  const dir = bootMarkerDir(stateDir);
  return (markerNames(dir) ?? []).flatMap((name) => {
    try {
      const marker = parseBootMarker(readFileSync(join(dir, name), 'utf8'));
      return marker ? [marker] : [];
    } catch {
      return [];
    }
  });
}

/**
 * Say that this process owns the port — the listen callback's to call, once.
 *
 * A marker that cannot be written costs the NEXT boot its verdict on this one,
 * not this console its start, so it is a warning and never a throw.
 */
export function writeBootMarker(
  port: number,
  opts: { pid?: number; startedAt?: string; stateDir?: string } = {},
): BootMarker | null {
  const pid = opts.pid ?? process.pid;
  const marker: BootMarker = { pid, startedAt: opts.startedAt ?? SELF_STARTED_AT, port, at: new Date().toISOString() };
  const file = bootMarkerFile(pid, opts.stateDir ?? INSTANCE_STATE_DIR);
  try {
    mkdirSync(dirname(file), { recursive: true });
    // Whole or absent: the next boot must never meet half a marker.
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(marker)}\n`);
    renameSync(tmp, file);
    return marker;
  } catch (error) {
    log.warn('boot-marker.write-failed', { file, error: String(error) });
    return null;
  }
}

/**
 * Remove this process's marker — the other half of its exit record, called
 * from the same place.
 *
 * Only a marker this process wrote, matched on its start time as well as its
 * pid: a launch the port refused wrote none and removes none, and no other
 * console's is ever touched. Never throws — it runs on the exit path.
 */
export function releaseBootMarker(opts: { pid?: number; startedAt?: string; stateDir?: string } = {}): boolean {
  const file = bootMarkerFile(opts.pid ?? process.pid, opts.stateDir ?? INSTANCE_STATE_DIR);
  try {
    const marker = parseBootMarker(readFileSync(file, 'utf8'));
    if (!marker || marker.startedAt !== (opts.startedAt ?? SELF_STARTED_AT)) return false;
    rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** What a boot learned from the markers the consoles before it left. */
export type PreviousBoots = {
  /** Markers whose process is gone: each one a hard ending, and each now a line of the ledger. */
  crashed: BootMarker[];
  /** Markers whose process still runs: the console a duplicate launch is refused by, or one still draining. */
  live: BootMarker[];
  /**
   * `false` when a hard ending was found; `true` when a console has owned the
   * port before and every one of them took its marker with it; `null` when
   * there is nothing to conclude — no console ever wrote one here, the one
   * that did is still running, or another launch settled it first.
   */
  endedCleanly: boolean | null;
};

/**
 * Settle the markers earlier consoles left against the processes they name —
 * once, at boot — and put every hard ending on the ledger.
 *
 * Asked BEFORE this launch knows whether the port will be its own, which is
 * safe for the case that matters: a duplicate finds the live console's marker,
 * its process running, and records nothing. A marker whose process is gone — or
 * is a zombie, or whose pid now belongs to a process that started at another
 * time — is claimed with an `unlink`, and only the launch whose `unlink`
 * succeeds records it: launches racing over one dead console count it once, and
 * a launch that then loses the port to something that is not a console does not
 * count it again on every retry its supervisor makes.
 *
 * Before the service opens, so the breaker's `crashLoop()` and the inbox row
 * both see the boot that noticed.
 */
export async function settleBootMarkers(opts: { pid?: number; stateDir?: string } = {}): Promise<PreviousBoots> {
  const self = opts.pid ?? process.pid;
  const stateDir = opts.stateDir ?? INSTANCE_STATE_DIR;
  const dir = bootMarkerDir(stateDir);
  const names = markerNames(dir);
  // No console has ever owned the port here with a marker to leave.
  if (!names) return { crashed: [], live: [], endedCleanly: null };

  const crashed: BootMarker[] = [];
  const live: BootMarker[] = [];
  let unsettled = false;
  for (const name of names) {
    const file = join(dir, name);
    let raw: string;
    try { raw = readFileSync(file, 'utf8'); } catch { continue; } // taken with its owner's clean exit
    const marker = parseBootMarker(raw);
    if (!marker) {
      // Nothing to judge it by. It is not evidence of anything, only clutter.
      try { rmSync(file, { force: true }); } catch { /* the next boot tries again */ }
      continue;
    }
    if (!(await ownerGone(marker, self))) {
      live.push(marker);
      continue;
    }
    try {
      unlinkSync(file);
    } catch {
      // Another launch claimed it first, and the ending is on the ledger once.
      unsettled = true;
      continue;
    }
    crashed.push(marker);
  }

  // One line per ending, each stamped with THIS boot's pid — the stamp
  // `announceCrashedBoot` keys its once-per-boot row on.
  const snapshot = crashed.length ? latestHeapSnapshot(stateDir) ?? undefined : undefined;
  for (const _ended of crashed) recordCrashedBoot({ pid: self, snapshot }, stateDir);
  return {
    crashed,
    live,
    endedCleanly: crashed.length ? false : (live.length || unsettled) ? null : true,
  };
}

/**
 * Is the process that wrote this marker gone?
 *
 * A zombie counts as gone: it has exited, and a clean exit would have taken the
 * marker with it before it got that far. A stopped process does not — it still
 * holds the port's socket. And a marker under the booting process's OWN pid was
 * left by an earlier holder of that pid, since this one has written nothing yet.
 */
async function ownerGone(marker: BootMarker, self: number): Promise<boolean> {
  if (marker.pid === self) return true;
  const state = await processStateAsync(marker.pid, { startedAt: marker.startedAt });
  return state === 'gone' || state === 'zombie';
}

/* ------------------------------------------------------------------ *
 * The latch the park writers consult
 * ------------------------------------------------------------------ */

/**
 * Why this console is not adopting what an earlier one left, or `null`.
 *
 * The breaker that stops re-adoption and convergence is not enough on its own,
 * and that gap is the measured shape of the incident: the park those two doors
 * guard is not the park that happened. `reconcileRun` writes
 * `halt.kind: 'orphaned-session'` on the run-file READ path — a page view, a
 * sweep, anything that calls `listRuns` — and `recoverApprovals` adopts the
 * surviving child's hook token beside it. A hold that leaves those two open
 * re-parks live children on every crashed boot exactly as measured.
 *
 * A latch rather than a call into the service, because `runner/state.ts` is
 * below the service and must stay there. The service sets it once it knows its
 * own boot hold, and clears it when an operator releases.
 */
let adoptionHold: string | null = null;

/** Set or clear the reason adoption is held. The service owns this. */
export function setAdoptionHold(reason: string | null): void {
  if (adoptionHold === reason) return;
  adoptionHold = reason;
  log.info('boot.adoption-hold', { held: Boolean(reason), reason: reason ?? null });
}

/**
 * Why adoption is held, or `null`.
 *
 * Every writer of the orphan park consults this — `runner/state.ts`'s
 * `reconcileRun` and `service-base.ts`'s `recoverApprovals`, which is what
 * `crash-loop.test.ts` CL-6 scans the source for. A run met while it is held
 * keeps its status untouched: the reconcile is DEFERRED, not skipped, and runs
 * once when the hold lifts.
 */
export function adoptionHeld(): string | null {
  return adoptionHold;
}
