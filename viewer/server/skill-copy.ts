/**
 * Which copy of the skill a session reads, against the console that launches
 * it (control-tower phase 98, #151) — ONE reader, asked by the doctor's row,
 * `/api/state`'s field (Settings), the inbox's health row, the boot prompt,
 * the run-start prelude and `install-skill`.
 *
 * The console updates itself; the skill came from somewhere else. Every
 * session read SKILL.md from the `phased-execution` plugin, installed in each
 * Claude Code config dir from a marketplace clone nothing ever pulled — 49
 * commits behind the console that launched it, whose newer scripts it then
 * ran from a procedure that did not know them. What Claude Code has installed
 * is written down in `<config dir>/plugins/installed_plugins.json`, so that
 * file is the fact read here, per config dir: the user-scope install is the
 * copy a session under that dir loads, and its `gitCommitSha` is the commit to
 * hold against the console's own (`distRev`, the commit its client was built
 * from — what a self-update moves).
 *
 * A leaf on purpose, like `doctor.ts`: nothing here resolves an instance at
 * module load, so the CLI imports it (`bin/doctor-verb.mjs`, both bins'
 * `install-skill`) from a process that is not a console. Reading is all it
 * does — `scripts/update-plugin.sh` is the one writer, and it is Pro.
 */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import type { ProbeVerdict } from './prelude.ts';

/** The plugin the skill ships as — `.claude-plugin/marketplace.json`'s one entry, under its marketplace. */
export const SKILL_PLUGIN = 'phased-execution';
export const SKILL_PLUGIN_ID = `${SKILL_PLUGIN}@phased-execution-public`;

/**
 * The one indirection a console-composed prompt names a script through. Every
 * session the console spawns carries `PE_SCRIPTS=<its scriptsDir>`, so
 * `$PE_SCRIPTS/phase-outcome.sh` is resolved by the session's own shell to the
 * scripts of the console that launched it — never to a clone's, and never to a
 * path an older handoff wrote down.
 */
export const SCRIPTS_ENV = 'PE_SCRIPTS';
export const SCRIPTS_REF = `$${SCRIPTS_ENV}`;

/** Which Claude Code config dirs to read, space-separated — what the tests and a machine with other dirs set. */
export const CONFIG_DIRS_ENV = 'PE_CLAUDE_CONFIG_DIRS';

/**
 * How a person moves each half, in this edition's words. A list, so the free
 * build keeps Claude Code's own command and drops the Pro verb (the marker pair
 * strips whole lines); the last entry is the one said.
 */
export const UPDATE_SKILL_COMMAND = [
  `claude plugin update ${SKILL_PLUGIN_ID} (in each config dir)`,
].at(-1)!;
export const UPDATE_CONSOLE_COMMAND = [
  'pull its checkout and restart it',
].at(-1)!;

/** The interface pair beside the scripts (UP-6): `PE_API` this copy speaks, `PE_API_MIN` it needs of the other half. */
export const SKILL_API_FILE = 'skill-api.env';

export type PluginInstall = {
  /** `<plugin>@<marketplace>` as Claude Code keys it. */
  id: string;
  scope: string;
  installPath: string;
  /** The cache version — for this plugin, the commit's first 12 characters. */
  version: string | null;
  commit: string | null;
  projectPath?: string;
};

export type SkillCopy = {
  configDir: string;
  /** The user-scope install: the copy a session under this dir loads. Null when the plugin is not installed here. */
  install: PluginInstall | null;
  /** A `skills/phased-execution` directory beside it — a SECOND copy (`install-skill`'s, or a clone). */
  skillDir: string | null;
  /** `installed_plugins.json` exists and does not parse. */
  parseError?: string;
};

export type SkillCopyReport = {
  plugin: string;
  /** The console's own commit (`distRev`); null when it cannot say. */
  consoleRev: string | null;
  copies: SkillCopy[];
  /** The copies whose commit is not the console's. Empty when either side is unknown. */
  drift: SkillCopy[];
  /** How a person moves the skill to the console, in this edition's words — what Settings prints. */
  update: string;
};

/**
 * The config dirs whose plugins count. `PE_CLAUDE_CONFIG_DIRS` when set (a
 * test, or a machine with other names); else `CLAUDE_CONFIG_DIR`, `~/.claude`
 * and the two account dirs this product's operators keep beside it — those
 * that exist, each once however it is spelled.
 */
export function claudeConfigDirs(env: NodeJS.ProcessEnv = process.env, home: string = env.HOME || homedir()): string[] {
  const named = env[CONFIG_DIRS_ENV]?.trim();
  const candidates = named
    ? named.split(/\s+/)
    : [env.CLAUDE_CONFIG_DIR, join(home, '.claude'), join(home, '.claude-a'), join(home, '.claude-b')];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const dir = resolve(candidate);
    if (!isDir(dir)) continue;
    const real = safeRealpath(dir);
    if (seen.has(real)) continue;
    seen.add(real);
    out.push(dir);
  }
  return out;
}

/** Every install of the plugin one config dir registered, any scope — or why the file could not be read. */
export function readPluginInstalls(configDir: string): { installs: PluginInstall[]; parseError?: string } {
  const file = join(configDir, 'plugins', 'installed_plugins.json');
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { installs: [] };
    return { installs: [], parseError: String((error as Error)?.message ?? error) };
  }
  const plugins = (doc as { plugins?: unknown })?.plugins;
  if (!plugins || typeof plugins !== 'object') return { installs: [] };
  const installs: PluginInstall[] = [];
  // Any marketplace: a machine that installed the skill from another catalog
  // still runs THIS skill, and the question is which commit of it.
  for (const [id, raw] of Object.entries(plugins as Record<string, unknown>)) {
    if (id.split('@')[0] !== SKILL_PLUGIN) continue;
    // Version 2 keys a LIST of installs (one per scope); version 1 keyed one.
    for (const entry of Array.isArray(raw) ? raw : raw ? [raw] : []) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      if (typeof e.installPath !== 'string') continue;
      installs.push({
        id,
        scope: typeof e.scope === 'string' ? e.scope : 'user',
        installPath: e.installPath,
        version: typeof e.version === 'string' ? e.version : null,
        commit: typeof e.gitCommitSha === 'string' ? e.gitCommitSha : null,
        ...(typeof e.projectPath === 'string' ? { projectPath: e.projectPath } : {}),
      });
    }
  }
  // The canonical catalog first, so a machine with two names for the plugin
  // reports the one this product ships.
  installs.sort((a, b) => Number(b.id === SKILL_PLUGIN_ID) - Number(a.id === SKILL_PLUGIN_ID));
  return { installs };
}

/** The copy one config dir carries: its user-scope install, and any second copy under `skills/`. */
export function readSkillCopy(configDir: string): SkillCopy {
  const { installs, parseError } = readPluginInstalls(configDir);
  const install = installs.find((one) => one.scope === 'user') ?? null;
  const skillDir = join(configDir, 'skills', SKILL_PLUGIN);
  return {
    configDir,
    install,
    skillDir: existsSync(skillDir) ? skillDir : null,
    ...(parseError ? { parseError } : {}),
  };
}

/**
 * The copy a session under `configDir` loads — the account's config dir a run
 * spawns under. Where `PE_CLAUDE_CONFIG_DIRS` names the dirs that count (a
 * test's sandbox, a machine with other names), a dir outside that list is
 * never read: the first listed dir stands for it, so a sandbox cannot reach
 * the machine's own config through an account's default.
 */
export function sessionSkillCopy(configDir: string | null | undefined, env: NodeJS.ProcessEnv = process.env): SkillCopy | null {
  if (!env[CONFIG_DIRS_ENV]?.trim()) return configDir ? readSkillCopy(configDir) : null;
  const dirs = claudeConfigDirs(env);
  const wanted = configDir ? safeRealpath(resolve(configDir)) : null;
  const at = dirs.find((dir) => safeRealpath(dir) === wanted) ?? dirs[0];
  return at ? readSkillCopy(at) : null;
}

/**
 * Do two names of a commit name the same one? A plugin version is the sha's
 * first 12 characters and `distRev` the whole sha, so the shorter is compared
 * as a prefix of the longer — never under seven, which stops meaning a commit.
 * `null` when either side is unknown: no verdict is not a match.
 */
export function sameCommit(a: string | null | undefined, b: string | null | undefined): boolean | null {
  const x = normalRev(a);
  const y = normalRev(b);
  if (!x || !y) return null;
  return x.length <= y.length ? y.startsWith(x) : x.startsWith(y);
}

function normalRev(rev: string | null | undefined): string | null {
  const text = rev?.trim().toLowerCase();
  return text && /^[0-9a-f]{7,40}$/.test(text) ? text : null;
}

/** The commit a copy is at: the sha the install recorded, else its version when that is commit-shaped. */
export function copyCommit(copy: SkillCopy): string | null {
  return normalRev(copy.install?.commit) ?? normalRev(copy.install?.version);
}

/** Every config dir's copy, against the console's commit. */
export function skillCopyReport(input: { configDirs: readonly string[]; consoleRev: string | null | undefined }): SkillCopyReport {
  const copies = input.configDirs.map(readSkillCopy);
  const consoleRev = normalRev(input.consoleRev);
  return {
    plugin: SKILL_PLUGIN_ID,
    consoleRev,
    copies,
    drift: consoleRev ? copies.filter((copy) => copy.install && sameCommit(copyCommit(copy), consoleRev) === false) : [],
    update: UPDATE_SKILL_COMMAND,
  };
}

const short = (rev: string | null | undefined) => (rev ? rev.slice(0, 12) : 'an unknown commit');

/**
 * The doctor's `skill` row. `ok` when every installed copy is at the console's
 * commit (or the console cannot say its own); `fail` — never blocking, a
 * drifted skill still runs a console — naming each copy that is not; `skip`
 * when no config dir has the plugin at all. A second copy under `skills/` is a
 * warning on whatever the row says: two copies are how nobody could tell which
 * one was live.
 */
export function skillCopyVerdict(report: SkillCopyReport | null): ProbeVerdict {
  if (!report) return { status: 'skip', ok: true, reason: 'the skill copies were not read here' };
  const warnings = report.copies.flatMap((copy) => [
    ...(copy.parseError ? [`${copy.configDir}/plugins/installed_plugins.json does not parse — ${copy.parseError}`] : []),
    ...(copy.skillDir
      ? [`a second copy at ${copy.skillDir}${copy.install ? ' beside the plugin' : ''} — phase-console uninstall-skill removes one it installed`]
      : []),
  ]);
  const withWarnings = warnings.length ? { warnings } : {};
  const installed = report.copies.filter((copy) => copy.install);
  if (!installed.length) {
    const looked = report.copies.map((copy) => copy.configDir).join(', ') || 'no Claude Code config dir';
    return {
      status: 'skip', ok: true, ...withWarnings,
      reason: `no plugin copy of ${report.plugin} is installed in ${looked} — sessions read the skill from wherever Claude Code finds it`,
    };
  }
  const detail = { consoleRev: report.consoleRev, copies: report.copies };
  if (report.drift.length) {
    const named = report.drift.map((copy) => `${copy.configDir} carries ${short(copyCommit(copy))} (${copy.install!.installPath})`);
    return {
      status: 'fail', ok: false, detail, ...withWarnings,
      reason: `the skill sessions read is not the console's commit ${short(report.consoleRev)}: ${named.join('; ')} `
        + `— update it: ${UPDATE_SKILL_COMMAND}`,
    };
  }
  const dirs = installed.map((copy) => copy.configDir).join(', ');
  const at = copyCommit(installed[0]!);
  return {
    status: 'ok', ok: true, detail, ...withWarnings,
    reason: report.consoleRev
      ? `${report.plugin} at ${short(at)} in ${dirs} — the console's own commit (${installed[0]!.install!.installPath})`
      : `${report.plugin} at ${short(at)} in ${dirs} — the console cannot say its own commit (an unbuilt client), so nothing is compared`,
  };
}

/* ------------------------------------------------------------------ *
 * UP-6 — the interface pair
 * ------------------------------------------------------------------ */

/** One copy's `skill-api.env`. */
export type SkillApi = { api: number; min: number; file: string };

/**
 * Which half is too old, when the two cannot work together: the SKILL's scripts
 * reject flags this console uses (its `PE_API` is under the console's
 * `PE_API_MIN`), or the reverse. Null when they meet — or when either side
 * carries no stamp, which is no verdict rather than a pass.
 */
export type SkillApiMismatch = { update: 'skill' | 'console'; reason: string };

/** Read `<scriptsDir>/skill-api.env`; null when it is absent or says no numbers. */
export function readSkillApi(scriptsDir: string): SkillApi | null {
  const file = join(scriptsDir, SKILL_API_FILE);
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch { return null; }
  const value = (key: string) => {
    const m = new RegExp(`^${key}=["']?(\\d+)["']?\\s*(?:#.*)?$`, 'm').exec(text);
    return m ? Number(m[1]) : null;
  };
  const api = value('PE_API');
  const min = value('PE_API_MIN');
  if (api === null || min === null) return null;
  return { api, min, file };
}

export function skillApiVerdict(consoleApi: SkillApi | null, skillApi: SkillApi | null): SkillApiMismatch | null {
  if (!consoleApi || !skillApi) return null;
  if (skillApi.api < consoleApi.min) {
    return {
      update: 'skill',
      reason: `the skill's scripts speak interface ${skillApi.api} (${skillApi.file}) and this console needs at least `
        + `${consoleApi.min} — update the skill (${UPDATE_SKILL_COMMAND})`,
    };
  }
  if (consoleApi.api < skillApi.min) {
    return {
      update: 'console',
      reason: `this console's scripts speak interface ${consoleApi.api} (${consoleApi.file}) and the skill needs at least `
        + `${skillApi.min} — update the console (${UPDATE_CONSOLE_COMMAND})`,
    };
  }
  return null;
}

function isDir(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function safeRealpath(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}
