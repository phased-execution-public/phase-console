/**
 * The environment doctor: facts about THIS process's environment that nothing
 * else ever reports.
 *
 * The measured defect: the live console's launchd plist carried a PATH with a
 * different user's home in it (a macOS home path belonging to somebody else) plus five
 * directories that do not exist — baked at install time from whatever shell
 * ran the installer, and invisible ever since. A thin or foreign PATH is not
 * fatal (`hardenedPath` rescues the standard dirs at verify time), but it is
 * exactly the class of quiet rot that later reads as "the console is broken".
 *
 * Pure and dependency-light so it is trivially testable: the report is
 * computed from an env you hand it. The service computes it once at
 * construction, `state()` carries it (`environment.issues`), the boot log
 * warns, and a foreign-home entry announces on the `health` channel once per
 * process. G10 appends push-delivery issues to the same list — one place the
 * console admits its own environment is off.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';

export type EnvIssue = {
  kind: 'path-missing-dir' | 'path-foreign-home' | 'push-broken';
  detail: string;
  /** The errand, named — what a person does about it. */
  fix: string;
  /**
   * A stable id for an issue the console re-evaluates and may withdraw — the
   * delivery-channel row below. Absent on the issues computed once and kept.
   */
  id?: string;
};

/** The id of the boot doctor's channel row (zero-touch phase 17, FLT-1 ii). */
export const DELIVERY_ISSUE_ID = 'delivery-channel';

/**
 * The boot doctor's channel row: a console must reach a person — one subscribed
 * device, the operator's notifier, or one webhook row; with `--remote`, Tailscale
 * running and serving this port. `verdict` is the prelude's own
 * `probeDelivery` (phase 11), so the run-start row and this one cannot
 * disagree. `category` names the first announcement that found nobody.
 */
export function deliveryIssue(verdict: { ok: boolean; reason: string }, category?: string | null): EnvIssue | null {
  if (verdict.ok) return null;
  return {
    kind: 'push-broken',
    id: DELIVERY_ISSUE_ID,
    detail: `${verdict.reason}${category ? ` — "${category}" announcements are reaching nobody` : ''}`,
    fix:
      'Give this console one way to reach you: subscribe a device (Settings → Notifications, from the phone), '
      + 'set a notifier (`notifyCommand` in ~/.config/phase-console/fleet.json, or PHASE_CONSOLE_NOTIFY), or register '
      + 'a webhook. With --remote, start Tailscale and point Serve at this console’s port.',
  };
}

/**
 * The Pro tree can bake a cleaned PATH into the unit when the agent is
 * re-installed; the free tree has no unit, so this tail assembles to nothing
 * there and the errand above stands on its own.
 */
const PRO_REINSTALL = [
].join('');

const REINSTALL =
  'Start the console from a shell with a complete PATH, and consider removing the '
  + `entry from your shell profile.${PRO_REINSTALL}`;

export function environmentReport(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): EnvIssue[] {
  const issues: EnvIssue[] = [];
  for (const dir of (env.PATH ?? '').split(':').filter(Boolean)) {
    const underHome = /^\/(?:Users|home)\/[^/]+(\/|$)/.test(dir);
    if (underHome && dir !== home && !dir.startsWith(`${home}/`)) {
      issues.push({
        kind: 'path-foreign-home',
        detail: `PATH entry under a different user's home: ${dir}`,
        fix: REINSTALL,
      });
      continue;
    }
    if (!existsSync(dir)) {
      issues.push({
        kind: 'path-missing-dir',
        detail: `PATH entry does not exist: ${dir}`,
        fix: `Harmless if deliberate. ${REINSTALL}`,
      });
    }
  }
  return issues;
}

/* ------------------------------------------------------------------ *
 * git, under this process's own PATH (5.1.0, errand E7)
 * ------------------------------------------------------------------ */

/**
 * The facts `doctor.ts`'s `gitVerdict` grades. Collected here because this is
 * the module about what THIS process's environment actually is, as opposed to
 * what a person's interactive shell would answer.
 *
 * `exec` is injected so the probe is testable and so the two callers — the
 * live console and the offline CLI verb — can each supply the runner they
 * already have, rather than this module importing a child-process seam into
 * a file whose whole value is that it imports almost nothing.
 */
export type GitProbeExec = (
  file: string,
  args: readonly string[],
  opts?: { cwd?: string },
) => Promise<{ code: number | null; stdout: string; stderr: string }>;

export async function probeGit(
  exec: GitProbeExec,
  root: string | null,
): Promise<{ version: string | null; code: number | null; stderr?: string; insideWorkTree: boolean | null; path?: string; root?: string | null }> {
  const first = (text: string): string => (text ?? '').split('\n').find((line) => line.trim()) ?? '';

  // WHICH git, before whether it works: two are usually installed (Apple's
  // shim in /usr/bin and Homebrew's in /opt/homebrew/bin) and under launchd
  // the first one wins, which is exactly the E7 trap.
  let path: string | undefined;
  try {
    const which = await exec('/usr/bin/which', ['git']);
    if (which.code === 0) path = first(which.stdout).trim() || undefined;
  } catch {
    /* `which` is a convenience; its absence must not fail the probe */
  }

  let version: { code: number | null; stdout: string; stderr: string };
  try {
    version = await exec('git', ['--version']);
  } catch {
    return { version: null, code: null, insideWorkTree: null, ...(path ? { path } : {}), root };
  }
  if (version.code !== 0) {
    return {
      version: first(version.stdout).trim() || null,
      code: version.code,
      stderr: first(version.stderr).trim(),
      insideWorkTree: null,
      ...(path ? { path } : {}),
      root,
    };
  }

  // `null` rather than `false` with no root open: there is nothing to be
  // inside, which is not the same as being outside a repository.
  let insideWorkTree: boolean | null = null;
  if (root) {
    try {
      const inside = await exec('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root });
      insideWorkTree = inside.code === 0 && first(inside.stdout).trim() === 'true';
    } catch {
      insideWorkTree = null;
    }
  }
  return {
    version: first(version.stdout).trim() || null,
    code: 0,
    insideWorkTree,
    ...(path ? { path } : {}),
    root,
  };
}
