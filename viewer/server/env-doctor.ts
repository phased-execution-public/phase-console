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
};

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
