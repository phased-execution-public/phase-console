// `phase-console doctor` names every STRAY console server process — one whose
// PACKAGE root (the directory holding its own `package.json`; the same fact
// `SKILL_DIR` names for this very process, `server/config.ts`) no longer
// exists — and `--stop-strays` stops exactly those (#155, control-tower
// phase 98 EC8 PS-3).
//
// This is deliberately never under `viewer/server/`: `server/pid.ts` is the
// one place that shells `ps` and the one place that asks whether a single
// process THIS console is tracking is alive (`invariants.test.ts` clause 1).
// A stray scan is a different question — a MACHINE-WIDE census no live
// console ever needs to ask about itself — so it lives here instead, beside
// the verb that is its only caller.
//
// Every function below is pure over its inputs (or takes its `ps` read and
// its `kill` as injectable dependencies), so a test can feed a fake listing
// and a stubbed kill rather than deleting a real root out from under a live
// console, or signalling a process nobody started.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

/** The one shelled `ps` outside `server/pid.ts` — a machine-wide snapshot, not a probe of one pid. */
function execPs() {
  return new Promise((resolve) => {
    execFile('ps', ['-axo', 'pid=,pgid=,command='], { maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      resolve(error ? '' : String(stdout ?? ''));
    });
  });
}

/**
 * `ps -axo pid=,pgid=,command=` lines into `{pid, pgid, command}` rows. Blank
 * lines and anything that does not start with two numbers are dropped rather
 * than thrown on — a scan that crashes on one odd line is worse than one that
 * silently sees fewer processes.
 */
export function parsePsSnapshot(text) {
  const rows = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    rows.push({ pid: Number(m[1]), pgid: Number(m[2]), command: m[3] });
  }
  return rows;
}

// A console's own entry — dev (`.ts`) or a bundle (`.js`), Pro's `server/` or
// the fleet supervisor's `fleet/`, both directly under `viewer/`.
const SCRIPT_PATTERN = /(\S*\/viewer\/(?:server|fleet)\/index\.(?:m?js|ts))(?=\s|$)/;

/** The console-server script an argv names, or `null` when the command is not one at all. */
export function scriptPathOf(command) {
  return SCRIPT_PATTERN.exec(command)?.[1] ?? null;
}

export function isConsoleServerCommand(command) {
  return scriptPathOf(command) !== null;
}

/**
 * The package root a console script implies — three `dirname()`s up from
 * `<root>/viewer/(server|fleet)/index.*`, exactly how `SKILL_DIR` derives it
 * from its own module path (`config.ts`: `SKILL_DIR = dirname(VIEWER_DIR)`,
 * `VIEWER_DIR = dirname(dirname(fileURLToPath(import.meta.url)))`, read from
 * a file that — like `index.*` — sits directly inside `viewer/server/`).
 *
 * Deliberately NOT the `--root` flag on the same command line: that names the
 * PLAN LIBRARY a console opens, a fact that says nothing about whether the
 * console's own CODE still exists — and reading it here would misjudge every
 * ordinary test console, which points `--root` at a sandbox for the length of
 * one test while its code stays checked out for the length of the suite.
 */
export function packageRootOfScript(scriptPath) {
  return dirname(dirname(dirname(scriptPath)));
}

/**
 * Strays among `processes`: a console server whose package root is gone.
 * `exists` is injected so a test can feed a fake filesystem it never has to
 * delete anything real to exercise. This process's own pid is excluded on
 * principle — a stray scan naming itself would be a scan that cannot run.
 */
export function judgeStrays(processes, { exists = existsSync } = {}) {
  const strays = [];
  for (const proc of processes) {
    if (proc.pid === process.pid) continue;
    const script = scriptPathOf(proc.command);
    if (!script) continue;
    const root = packageRootOfScript(script);
    if (exists(root)) continue;
    strays.push({ pid: proc.pid, pgid: proc.pgid, command: proc.command, root });
  }
  return strays;
}

/**
 * The real machine-wide scan: shell `ps`, parse it, judge it. `opts.psText`
 * lets a test skip the real shell-out while still exercising this function
 * (as opposed to calling `judgeStrays(parsePsSnapshot(...))` directly).
 */
export async function listStrayConsoles(opts = {}) {
  const text = opts.psText !== undefined ? opts.psText : await execPs();
  return judgeStrays(parsePsSnapshot(text), opts);
}

/**
 * TERM the process GROUP, wait, KILL it if it is still there — the same
 * ladder `runner/signals.ts` uses to end a phase session, addressed by
 * `pgid` (not the bare pid) because a stray's own launcher — the shim that
 * forked it — is usually the thing that is already gone; only `ps`'s own
 * `pgid=` column still names the group it left behind. Every dependency is
 * injectable so a test can prove the ordering (TERM before KILL, KILL only
 * when TERM was not enough) without touching a real process.
 */
export async function stopStray(stray, opts = {}) {
  const kill = opts.kill ?? process.kill;
  const wait = opts.wait ?? ((ms) => new Promise((resolve) => { setTimeout(resolve, ms); }));
  const alive = opts.alive ?? ((pid) => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  });
  const graceMs = opts.graceMs ?? 2000;
  try { kill(-stray.pgid, 'SIGTERM'); } catch { /* already gone */ }
  await wait(graceMs);
  if (!alive(stray.pid)) return true;
  try { kill(-stray.pgid, 'SIGKILL'); } catch { /* already gone */ }
  await wait(opts.killWaitMs ?? 50);
  return !alive(stray.pid);
}

/** `stopStray` over a whole list, each result named beside the stray it was. */
export async function stopStrayConsoles(strays, opts = {}) {
  const results = [];
  for (const stray of strays) {
    // eslint-disable-next-line no-await-in-loop -- each stop is TERM-wait-KILL; running them concurrently would not shorten the wall clock, only overlap the grace periods.
    const stopped = await stopStray(stray, opts);
    results.push({ ...stray, stopped });
  }
  return results;
}
