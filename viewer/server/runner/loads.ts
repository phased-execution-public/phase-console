/**
 * What an unattended session loads (measured-console phase 11, §Architecture
 * 6 D2): the console's own skill from the tree it built for its revision
 * (`--plugin-dir`, `server/plugin-tree.ts`), the curated seed's entries
 * (`CLAUDE_CODE_PLUGIN_SEED_DIR`, `server/seed.ts`), the personal plugins a
 * person switched on for autopilot (`autopilotPlugins`) — and nothing else.
 *
 * Under `autopilotLoads: console-set` (9.0's default) a session is started
 * with `--setting-sources project,local`, so the operator's user-level hooks,
 * plugins and skills do not load unattended; the console's presence hooks come
 * from the plugin's own `hooks/hooks.json` (`PE_PLUGIN_HOOKS=1` makes that copy
 * answer although the user's settings still carry a spliced entry). The run's
 * `--settings` file names `enabledPlugins`: the installed
 * `phased-execution@phased-execution-public` OFF, so two copies of the skill
 * never load, each seed entry ON, each switched-on personal plugin ON.
 * `operator-config` is 8.0's behaviour — none of the three, the config dir
 * decides — kept for a person who wants their own set unattended.
 *
 * Measured on CLI 2.1.310 (2026-10-25): with the three, a session's
 * `system/init.plugins` named the tree (`phased-execution@inline`), the two
 * enabled seed entries and the CLI's built-ins, and none of the operator's
 * personal plugins; a config dir's first session with a seed only syncs its
 * marketplace, the second loads it (phase 10).
 *
 * Also here: the resolved SKILL SET those sessions carry, as the words
 * `PE_SKILLS` tells the engine (F47 and the Skill-tool line, phase-graph.sh) —
 * `plugin:name` per skill, a trailing `!` on one marked
 * `disable-model-invocation`, which the Skill tool refuses. Read from the trees
 * on disk, and widened by what sessions' own `system/init` frames reported
 * (`noteObservedSkills`), which is how the CLI's built-in skills get in.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { newestPerPlugin, parseInstalledPlugins } from '../../shared/installed-plugins.js';
import { AUTOPILOT_LOADS } from '../../shared/prefs-model.js';
import { entryIsSkill, entryPlugin, pluginEntriesFor, type PLUGIN_MISSING_REASONS, type PluginEntry } from '../../shared/plugin-sets.js';
import { parseFrontMatter, scalar } from '../parse/frontmatter.ts';
import { currentPluginDir } from '../plugin-tree.ts';
import { SEED_ENV, readSeed, type SeedFacts } from '../seed.ts';

export type AutopilotLoads = (typeof AUTOPILOT_LOADS)[number];

/** The ONE value `sanitize()` lets `--setting-sources` carry (`spawn.ts`). */
export const SETTING_SOURCES_CONSOLE_SET = 'project,local';
/** The installed copy of the skill, switched OFF where the console's tree loads. */
export const CONSOLE_PLUGIN_ID = 'phased-execution@phased-execution-public';
/** Makes the tree's `session-hook.sh` answer although the user's settings carry a spliced entry (phase 10). */
export const PLUGIN_HOOKS_ENV = 'PE_PLUGIN_HOOKS';
/** A personal plugin id as `enabledPlugins` keys it: `<name>@<marketplace>`. */
export const PLUGIN_ID_RE = /^[A-Za-z0-9][\w.-]*@[A-Za-z0-9][\w.-]*$/;

export function isAutopilotLoads(value: unknown): value is AutopilotLoads {
  return typeof value === 'string' && (AUTOPILOT_LOADS as readonly string[]).includes(value);
}

/** The ids `autopilotPlugins` may hold — well-formed, once each, never the console's own. */
export function autopilotPluginsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id): id is string => typeof id === 'string' && PLUGIN_ID_RE.test(id.trim()))
    .map((id) => id.trim()))].filter((id) => id !== CONSOLE_PLUGIN_ID);
}

export type SessionLoads = {
  mode: AutopilotLoads;
  /** `--plugin-dir`, one per entry. */
  pluginDirs: string[];
  /** `--setting-sources`, only ever this one value. */
  settingSources?: typeof SETTING_SOURCES_CONSOLE_SET;
  /** Added to the session's environment. */
  env: Record<string, string>;
  /** The run's `--settings` file's `enabledPlugins`; absent under `operator-config`. */
  enabledPlugins?: Record<string, boolean>;
  /** The resolved skill set, `PE_SKILLS`' words. */
  skills: string[];
  /** What could not be had, in words — a tree that did not build, no seed. */
  missing: string[];
  /**
   * The operator's user-level `permissions.deny` rules, carried into the run's
   * own settings file: `--setting-sources project,local` leaves the user's
   * settings out, and a person's deny rule (a secret file, a command they never
   * want run) must not be lost with their plugins. Empty under operator-config,
   * where the user's settings load themselves.
   */
  carriedDeny: string[];
  /** The hook events the user's settings register that a console-set session leaves out, by name — said in `phase.plugins`. */
  userHooksLeftOut: string[];
};

/** A personal plugin switched on for autopilot, with where its config dir installed it (when known). */
export type PersonalPlugin = { id: string; installPath?: string };

const SKILL_FILE = 'SKILL.md';
const MAX_DEPTH = 3;

/** Every `SKILL.md` under `dir`, at most `MAX_DEPTH` directories down, never inside `node_modules` or `.git`. */
function skillFiles(dir: string, depth = 0): string[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  const out: string[] = [];
  if (names.includes(SKILL_FILE)) out.push(join(dir, SKILL_FILE));
  if (depth >= MAX_DEPTH) return out;
  for (const name of names.sort()) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const child = join(dir, name);
    try { if (!statSync(child).isDirectory()) continue; } catch { continue; }
    out.push(...skillFiles(child, depth + 1));
  }
  return out;
}

/** One skill's word: its name (frontmatter, else its directory), `!` when the model may not invoke it. */
function skillWord(file: string, plugin: string): { dirName: string; word: string } | null {
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch { return null; }
  const { values } = parseFrontMatter(text);
  const dirName = basename(dirname(file));
  const name = scalar(String(values.name ?? '')) || dirName;
  const off = scalar(String(values['disable-model-invocation'] ?? '')).toLowerCase() === 'true';
  return { dirName, word: `${plugin}:${name}${off ? '!' : ''}` };
}

/**
 * The skills a plugin directory carries, as `PE_SKILLS` words. `only` limits
 * them to the names a marketplace entry's `skills` array kept (by directory or
 * name); absent, every `SKILL.md` found counts.
 */
export function pluginSkills(dir: string, plugin: string, only?: readonly string[]): string[] {
  const words: string[] = [];
  for (const file of skillFiles(dir)) {
    const skill = skillWord(file, plugin);
    if (!skill) continue;
    const bare = skill.word.slice(plugin.length + 1).replace(/!$/, '');
    if (only && !only.includes(skill.dirName) && !only.includes(bare)) continue;
    words.push(skill.word);
  }
  return [...new Set(words)];
}

/** The console tree's plugin name — its manifest's, else `phased-execution`. */
function treePluginName(dir: string): string {
  try {
    const name = JSON.parse(readFileSync(join(dir, '.claude-plugin', 'plugin.json'), 'utf8')).name;
    if (typeof name === 'string' && name) return name;
  } catch { /* the default */ }
  return 'phased-execution';
}

/** What sessions' own `system/init` frames reported loaded (`noteObservedSkills`), console-set sessions only. */
const observed = new Set<string>();

/**
 * Widen the resolved set with what a console-set session's `system/init`
 * reported: its `skills` (the model may invoke each) and the `slash_commands`
 * that are not among them (a person's only — `!`). Bounded; names only.
 */
export function noteObservedSkills(skills: readonly string[] | undefined, commands: readonly string[] | undefined): void {
  const invocable = new Set((skills ?? []).filter((s) => typeof s === 'string' && s && s.length <= 120));
  for (const name of invocable) observed.add(name);
  for (const name of commands ?? []) {
    if (typeof name === 'string' && name && name.length <= 120 && !invocable.has(name)) observed.add(`${name}!`);
  }
  if (observed.size > 500) observed.clear();
}

/** Tests only. */
export function forgetObservedSkills(): void {
  observed.clear();
  cached = null;
}

/**
 * The whole answer for one spawn. Pure apart from reading the trees' skill
 * files; the caller resolves the tree, the seed and each personal plugin's
 * install path.
 */
export function composeLoads(input: {
  mode: AutopilotLoads;
  pluginDir: string | null;
  seed: SeedFacts | null;
  personal: readonly PersonalPlugin[];
  /** The user's own settings, as `userSettings` reads them. */
  user?: UserSettingsFacts;
}): SessionLoads {
  if (input.mode === 'operator-config') {
    return { mode: 'operator-config', pluginDirs: [], env: {}, skills: [], missing: [], carriedDeny: [], userHooksLeftOut: [] };
  }
  const missing: string[] = [];
  const enabledPlugins: Record<string, boolean> = {};
  const skills: string[] = [];
  if (input.pluginDir) {
    // Off, so the installed copy never loads beside the tree (`--plugin-dir`
    // silently overrides a same-named plugin anyway; this says it on purpose).
    enabledPlugins[CONSOLE_PLUGIN_ID] = false;
    skills.push(...pluginSkills(input.pluginDir, treePluginName(input.pluginDir)));
  } else {
    // No tree for this revision (it did not build, or has not yet): the
    // installed copy is the skill this session can have.
    enabledPlugins[CONSOLE_PLUGIN_ID] = true;
    missing.push('the console\'s plugin tree for this revision is not built — the installed phased-execution plugin loads instead');
  }
  const env: Record<string, string> = { [PLUGIN_HOOKS_ENV]: '1' };
  if (input.seed) {
    env[SEED_ENV] = input.seed.pluginsDir;
    for (const entry of input.seed.entries) {
      enabledPlugins[`${entry.name}@${input.seed.marketplace}`] = true;
      skills.push(...pluginSkills(join(input.seed.dir, entry.installPath), entry.name, entry.skills));
    }
  } else {
    missing.push('no plugin seed is built on this machine — phase-console seed build makes one');
  }
  for (const plugin of input.personal) {
    enabledPlugins[plugin.id] = true;
    const name = plugin.id.split('@')[0]!;
    if (plugin.installPath && existsSync(plugin.installPath)) skills.push(...pluginSkills(plugin.installPath, name));
    else missing.push(`the personal plugin ${plugin.id} is not installed in this console's config dir`);
  }
  for (const word of observed) skills.push(word);
  // One word per skill: a `!` from any source wins, since the CLI refuses it.
  const byName = new Map<string, string>();
  for (const word of skills) {
    const bare = word.replace(/!$/, '');
    if (!byName.has(bare) || word.endsWith('!')) byName.set(bare, word);
  }
  return {
    mode: 'console-set',
    pluginDirs: input.pluginDir ? [input.pluginDir] : [],
    settingSources: SETTING_SOURCES_CONSOLE_SET,
    env,
    enabledPlugins,
    skills: [...byName.values()],
    missing,
    carriedDeny: [...(input.user?.deny ?? [])],
    userHooksLeftOut: [...(input.user?.hookEvents ?? [])],
  };
}

export type UserSettingsFacts = { deny: string[]; hookEvents: string[] };

/**
 * What a config dir's user-level `settings.json` says that a console-set
 * session would otherwise lose: its `permissions.deny` rules (carried over)
 * and its hook events (left out on purpose, and named). Never throws.
 */
export function userSettings(configDir: string): UserSettingsFacts {
  try {
    const doc = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8')) as {
      permissions?: { deny?: unknown }; hooks?: Record<string, unknown>;
    };
    const deny = Array.isArray(doc.permissions?.deny)
      ? [...new Set(doc.permissions!.deny.filter((rule): rule is string => typeof rule === 'string' && rule.length > 0 && rule.length <= 500))]
      : [];
    const hookEvents = doc.hooks && typeof doc.hooks === 'object' ? Object.keys(doc.hooks).sort() : [];
    return { deny, hookEvents };
  } catch {
    return { deny: [], hookEvents: [] };
  }
}

/** A stable key for a loads answer — what the run's settings file was written from. */
export function loadsKey(loads: SessionLoads | null): string {
  if (!loads) return 'none';
  return JSON.stringify([loads.mode, loads.pluginDirs, loads.settingSources ?? null, loads.enabledPlugins ?? null, loads.carriedDeny]);
}

/**
 * Who a session's Skill-tool calls answered: each name the prompt carried,
 * matched against the calls the session made — qualified or not, so
 * `tdd` named and `mattpocock-skills:tdd` called is one skill.
 */
export function matchSkills(named: readonly string[], invoked: readonly string[]): {
  named: string[]; invoked: string[]; called: string[]; uncalled: string[]; unasked: string[];
} {
  const same = (a: string, b: string): boolean => a === b || a.endsWith(`:${b}`) || b.endsWith(`:${a}`);
  const n = [...new Set(named)];
  const i = [...new Set(invoked)];
  return {
    named: n,
    invoked: i,
    called: n.filter((name) => i.some((call) => same(name, call))),
    uncalled: n.filter((name) => !i.some((call) => same(name, call))),
    unasked: i.filter((call) => !n.some((name) => same(name, call))),
  };
}

/** Where the config dir installed each of `ids` — `installed_plugins.json`'s newest install, read by its one reader. */
export function personalPlugins(configDir: string, ids: readonly string[]): PersonalPlugin[] {
  let installs: { id: string; installPath: string }[] = [];
  try {
    installs = newestPerPlugin(parseInstalledPlugins(readFileSync(join(configDir, 'plugins', 'installed_plugins.json'), 'utf8')).installs);
  } catch { installs = []; }
  return ids.map((id) => {
    const hit = installs.find((one) => one.id === id);
    return hit?.installPath ? { id, installPath: hit.installPath } : { id };
  });
}

/** How long one answer stands: the engine asks on every board read, and the trees change at a boot or a build. */
export const LOADS_CACHE_MS = 30_000;
let cached: { at: number; key: string; value: SessionLoads } | null = null;

/**
 * This console's answer, from its settings, the tree its boot built, the
 * machine's seed and the config dir's installs — cached `LOADS_CACHE_MS` per
 * input, so a settings change lands on the next spawn.
 */
export function resolveSessionLoads(input: {
  mode: AutopilotLoads;
  plugins: readonly string[];
  configDir: string;
  env?: NodeJS.ProcessEnv;
  now?: number;
}): SessionLoads {
  const now = input.now ?? Date.now();
  const pluginDir = currentPluginDir();
  const seed = input.mode === 'console-set' ? readSeed(input.env).seed : null;
  const user = input.mode === 'console-set' ? userSettings(input.configDir) : { deny: [], hookEvents: [] };
  const key = JSON.stringify([input.mode, input.plugins, input.configDir, pluginDir, seed?.digest ?? null, observed.size, user]);
  if (cached && cached.key === key && now - cached.at < LOADS_CACHE_MS) return cached.value;
  const value = composeLoads({
    mode: input.mode, pluginDir, seed,
    personal: input.mode === 'console-set' ? personalPlugins(input.configDir, input.plugins) : [],
    user,
  });
  cached = { at: now, key, value };
  return value;
}

/**
 * One phase's plugin set, resolved for its session (measured-console phase 27,
 * D5): the kinds its plan line, its bullet and the run's per-phase choice
 * named, and what became of each entry the kinds bring.
 */
export type PhasePluginSet = {
  kinds: string[];
  /** `enabledPlugins` ids switched ON for this session alone — installed in the console's config dir. */
  enabled: string[];
  /** Entries the session loads anyway: their plugin is in the seed, switched on for autopilot, or carries the skill. */
  already: string[];
  /** Entries that will not load, each with its `PLUGIN_MISSING_REASONS` word. */
  missing: { name: string; reason: (typeof PLUGIN_MISSING_REASONS)[number] }[];
  /** Set in the session's environment, from the entries that load (`pinned`, `operator-set`). */
  env: Record<string, string>;
  /** Operator acts an `operator-set` entry that loads still needs, in words. */
  requires: string[];
};

/**
 * Resolve a phase's kinds against what its session loads: an entry whose
 * plugin the base answer already enables (the seed's, a personal plugin's) or
 * whose skill it carries is `already`; one whose plugin the config dir
 * installed is enabled by its INSTALLED id (never a second copy beside a seeded
 * one of the same name); the rest are named `missing`. A `plan-mode` entry
 * loads only in a phase that starts in plan mode. Pure.
 */
export function resolvePhasePlugins(input: {
  kinds: readonly string[];
  loads: SessionLoads | null;
  /** The config dir's installs, `installed_plugins.json`'s ids. */
  installed: readonly string[];
  permissionMode?: string;
}): PhasePluginSet {
  const out: PhasePluginSet = { kinds: [...input.kinds], enabled: [], already: [], missing: [], env: {}, requires: [] };
  const base = input.loads?.enabledPlugins ?? {};
  const loadedPlugin = (plugin: string): boolean =>
    Object.entries(base).some(([id, on]) => on && id.split('@')[0] === plugin);
  const skills = new Set((input.loads?.skills ?? []).map((word) => word.replace(/!$/, '')));
  const loads = (entry: PluginEntry): void => {
    Object.assign(out.env, entry.env ?? {});
    if (entry.requires && !out.requires.includes(entry.requires)) out.requires.push(entry.requires);
  };
  for (const entry of pluginEntriesFor(input.kinds)) {
    if (entry.unattended === 'plan-mode' && input.permissionMode !== 'plan') {
      out.missing.push({ name: entry.name, reason: 'plan-mode-only' });
      continue;
    }
    const plugin = entryPlugin(entry.name);
    const skill = entryIsSkill(entry.name);
    if (skill && skills.has(entry.name)) { out.already.push(entry.name); loads(entry); continue; }
    if (plugin && loadedPlugin(plugin)) {
      if (skill) { out.missing.push({ name: entry.name, reason: 'skill-not-carried' }); continue; }
      out.already.push(entry.name); loads(entry); continue;
    }
    const install = plugin ? input.installed.find((id) => id.split('@')[0] === plugin) : undefined;
    if (install) {
      if (!out.enabled.includes(install)) out.enabled.push(install);
      loads(entry);
      continue;
    }
    out.missing.push({ name: entry.name, reason: 'not-installed' });
  }
  return out;
}

/** The ids `installed_plugins.json` in `configDir` names, newest install per plugin; none when unreadable. */
export function installedPluginIds(configDir: string): string[] {
  try {
    return newestPerPlugin(parseInstalledPlugins(readFileSync(join(configDir, 'plugins', 'installed_plugins.json'), 'utf8')).installs)
      .map((one) => one.id);
  } catch { return []; }
}

/**
 * `phase.plugins`' `set` (measured-console phase 27): the kinds, what switched
 * on, what loaded anyway, what did not and why, the env NAMES (never values)
 * and the operator acts still owed. Names only — never a path.
 */
export function phasePluginsJournal(set: PhasePluginSet): Record<string, unknown> {
  return {
    kinds: set.kinds,
    ...(set.enabled.length ? { enabled: set.enabled } : {}),
    ...(set.already.length ? { already: set.already } : {}),
    ...(set.missing.length ? { missing: set.missing.map((one) => `${one.name} (${one.reason})`) } : {}),
    ...(Object.keys(set.env).length ? { env: Object.keys(set.env).sort() } : {}),
    ...(set.requires.length ? { requires: set.requires } : {}),
  };
}
