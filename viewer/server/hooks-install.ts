/**
 * The session-presence hook installer.
 *
 * `scripts/session-hook.sh` only helps once Claude Code runs it, and Claude
 * Code runs what `~/.claude/settings.json` names under `hooks`. This writes the
 * four entries — SessionStart, SessionEnd, Stop, Notification — into that file and takes
 * them out again, from Settings ▸ Automation (behind `--allow-writes`, since
 * it is a write outside the console's own state) and from
 * `phase-console install-hooks` / `uninstall-hooks`.
 *
 * The file is the operator's, not ours, so the rules are the launcher's:
 * **merge, never clobber** — the `hooks` value is the ONLY span of the file
 * that is rewritten; every other byte (every other key, its order, its
 * formatting, the indentation unit, the line ending, the trailing newline) is
 * carried through untouched, and a file that does not parse is refused
 * rather than replaced; **idempotent** — a second install changes nothing,
 * and an entry that points at another checkout of the skill is refreshed in
 * place rather than duplicated; **ours are recognisable** — by the script's
 * name in the command, which is how uninstall finds exactly the entries
 * install wrote and nothing else. Everything filesystem-shaped is a
 * parameter, so tests never touch a real `~/.claude`.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { fleetProfile } from '../shared/instances.mjs';
import { readSkillCopy } from './skill-copy.ts';

// Notification appended 2026-08-23: it is what tells the console a session is
// stopped waiting on a person (permission prompt, idle input) — the session-ask
// signal. An install from before then reads `partial: true` until re-installed.
export const HOOK_EVENTS = ['SessionStart', 'SessionEnd', 'Stop', 'Notification'] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

/** The script, relative to the skill root. */
export const HOOK_SCRIPT_REL = 'scripts/session-hook.sh';
/** How an entry of ours is recognised in somebody else's settings file. */
export const HOOK_MARKER = 'session-hook.sh';
/**
 * Seconds. SessionEnd hooks share a 1.5 s budget unless one asks for more,
 * and the script's own network timeout is 2 s — so 3, which is also what it
 * costs a session at most when the console is unreachable.
 */
export const HOOK_TIMEOUT_SECONDS = 3;
/**
 * SessionStart's own patience (measured-console phase 4): a supervised
 * session's SessionStart also prints the engine's brief (`phase-graph.sh
 * --brief N`, about two seconds over a large plan) after the presence POST's
 * two, so three would cut the brief — and with it the presence line — on a
 * slow machine. A SessionStart entry with less reads `brief: false`, and the
 * console then keeps the boot prompt whole (`PE_BRIEF` is left unset).
 */
export const HOOK_BRIEF_TIMEOUT_SECONDS = 15;

/** The timeout an entry of ours carries for one event. */
export function hookTimeoutFor(event: HookEvent): number {
  return event === 'SessionStart' ? HOOK_BRIEF_TIMEOUT_SECONDS : HOOK_TIMEOUT_SECONDS;
}

type HookCommand = { type: 'command'; command: string; timeout?: number; [key: string]: unknown };
type HookGroup = { matcher?: string; hooks?: HookCommand[]; [key: string]: unknown };
type Settings = Record<string, unknown> & { hooks?: Record<string, HookGroup[] | unknown> };

export type HooksStatus = {
  /** The settings file consulted. */
  path: string;
  exists: boolean;
  /** Every event has an entry of ours pointing at THIS checkout's script. */
  installed: boolean;
  /** Some events have one, some do not — or one points elsewhere. */
  partial: boolean;
  /** Per event: an entry of ours exists (pointing anywhere). */
  events: Record<HookEvent, boolean>;
  /** The command the entries name (or would name). */
  command: string;
  /** An entry of ours points at a script other than this checkout's. */
  stale: boolean;
  /**
   * Installed, and the SessionStart entry waits long enough for the brief
   * (`HOOK_BRIEF_TIMEOUT_SECONDS`) — what lets the runner set `PE_BRIEF=hook`
   * and leave out of the boot prompt what the brief carries.
   */
  brief: boolean;
  /**
   * The config dir's INSTALLED plugin carries the four entries in its own
   * `hooks/hooks.json` (measured-console phase 10) — presence is answered
   * whatever the settings file says. With the splice there too, the plugin's
   * copy steps aside for it (`session-hook.sh`), so `brief` stays the splice's.
   */
  viaPlugin: boolean;
  /** The file could not be parsed; nothing will be written to it. */
  parseError?: string;
};

export type HooksOptions = {
  /** Absolute path of the skill checkout (where `scripts/session-hook.sh` lives). */
  skillDir: string;
  /** The settings file; defaults to `$CLAUDE_CONFIG_DIR/settings.json`, else `~/.claude/settings.json`. */
  settingsPath?: string;
  env?: NodeJS.ProcessEnv;
  /**
   * The mode a file this CREATES gets — a profile workspace's files are 0600
   * like everything under the accounts dir. An existing file keeps its own.
   */
  mode?: number;
  /**
   * Write the four entries into the settings file even when the config dir's
   * installed plugin carries them in its own `hooks/hooks.json` (measured-
   * console phase 10). Off, an install over such a dir writes nothing: the
   * plugin's hooks ARE the presence hooks, and a spliced copy would answer
   * every event twice. The splice is for a user with no plugin — `install-hooks
   * --splice`, or a plugin from before hooks shipped in it.
   */
  splice?: boolean;
};

/** Claude Code's user-scope settings file, honouring `CLAUDE_CONFIG_DIR` the way the CLI does. */
export function defaultSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude');
  return join(dir, 'settings.json');
}

/**
 * The script every config dir's hooks run. A machine fact since zero-touch
 * phase 17 (FLT-8): the machine profile's `hookScript`, when it names a script
 * that exists, is the one path every console installs and every status
 * compares against — so two console copies on one machine stop pointing the
 * same four hooks at two different checkouts. Without it, this checkout's own.
 */
export function hookScriptPath(skillDir: string, env: NodeJS.ProcessEnv = process.env): string {
  try {
    const machine = fleetProfile(env).hookScript;
    if (machine && existsSync(machine)) return machine;
  } catch { /* an unreadable profile keeps this checkout's script */ }
  return join(skillDir, HOOK_SCRIPT_REL);
}

/** The command string the entry runs: bash on the absolute script path, quoted for a path with spaces. */
export function hookCommand(skillDir: string, env: NodeJS.ProcessEnv = process.env): string {
  return `bash "${hookScriptPath(skillDir, env)}"`;
}

export function hookEntry(skillDir: string, env: NodeJS.ProcessEnv = process.env, event: HookEvent = 'Stop'): HookCommand {
  return { type: 'command', command: hookCommand(skillDir, env), timeout: hookTimeoutFor(event) };
}

function isOurs(command: unknown): boolean {
  return typeof command === 'string' && command.includes(HOOK_MARKER);
}

function groupIsOurs(group: unknown): group is HookGroup {
  if (!group || typeof group !== 'object') return false;
  const hooks = (group as HookGroup).hooks;
  return Array.isArray(hooks) && hooks.some((hook) => hook && typeof hook === 'object' && isOurs((hook as HookCommand).command));
}

/* ------------------------------------------------------------------ *
 * Reading, and a scanner that finds the byte span of one top-level key
 * ------------------------------------------------------------------ */

type ReadSettings = {
  exists: boolean;
  raw: string;
  json: Settings;
  /** The indentation unit (the first indented line's leading whitespace). */
  indent: string;
  eol: '\n' | '\r\n';
  trailingNewline: boolean;
  mode?: number;
  parseError?: string;
};

/** Read the file and what it would take to write it back looking the same. */
export function readSettingsFile(path: string): ReadSettings {
  if (!existsSync(path)) return { exists: false, raw: '', json: {}, indent: '  ', eol: '\n', trailingNewline: true };
  const raw = readFileSync(path, 'utf8');
  let mode: number | undefined;
  try { mode = statSync(path).mode & 0o777; } catch { mode = undefined; }
  const eol: '\n' | '\r\n' = raw.includes('\r\n') ? '\r\n' : '\n';
  const indentMatch = /\n([ \t]+)\S/.exec(raw);
  const indent = indentMatch?.[1] ?? '  ';
  const trailingNewline = /\r?\n$/.test(raw) || raw.trim() === '';
  let json: Settings = {};
  let parseError: string | undefined;
  if (raw.trim()) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) parseError = 'the settings file is not a JSON object';
      else json = parsed as Settings;
    } catch (error) {
      parseError = (error as Error).message;
    }
  }
  return { exists: true, raw, json, indent, eol, trailingNewline, mode, ...(parseError ? { parseError } : {}) };
}

type TopLevel = {
  open: number;
  close: number;
  entries: { key: string; keyStart: number; valueStart: number; valueEnd: number }[];
};

const WS = new Set([' ', '\t', '\r', '\n']);

function skipWs(raw: string, i: number): number {
  while (i < raw.length && WS.has(raw[i])) i++;
  return i;
}

/** Past a JSON string starting at `i` (the opening quote); -1 when unterminated. */
function skipString(raw: string, i: number): number {
  i++;
  while (i < raw.length) {
    const c = raw[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '"') return i + 1;
    i++;
  }
  return -1;
}

/** Past one JSON value starting at `i`; -1 when it cannot be delimited. */
function skipValue(raw: string, i: number): number {
  const c = raw[i];
  if (c === '"') return skipString(raw, i);
  if (c === '{' || c === '[') {
    let depth = 0;
    while (i < raw.length) {
      const ch = raw[i];
      if (ch === '"') { i = skipString(raw, i); if (i < 0) return -1; continue; }
      if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') { depth--; if (depth === 0) return i + 1; }
      i++;
    }
    return -1;
  }
  while (i < raw.length && !WS.has(raw[i]) && raw[i] !== ',' && raw[i] !== '}' && raw[i] !== ']') i++;
  return i;
}

/**
 * The top-level object's keys with their byte spans, so one value can be
 * replaced, inserted or removed without touching any other byte. Null when
 * the text is not a plain object this can walk (the caller then re-renders
 * the whole file — correct JSON, merely reformatted).
 */
export function scanTopLevel(raw: string): TopLevel | null {
  let i = skipWs(raw, 0);
  if (raw[i] !== '{') return null;
  const open = i;
  i++;
  const entries: TopLevel['entries'] = [];
  for (;;) {
    i = skipWs(raw, i);
    if (raw[i] === '}') return { open, close: i, entries };
    if (raw[i] !== '"') return null;
    const keyStart = i;
    const keyEnd = skipString(raw, i);
    if (keyEnd < 0) return null;
    let key: string;
    try { key = JSON.parse(raw.slice(keyStart, keyEnd)) as string; } catch { return null; }
    i = skipWs(raw, keyEnd);
    if (raw[i] !== ':') return null;
    i = skipWs(raw, i + 1);
    const valueStart = i;
    const valueEnd = skipValue(raw, i);
    if (valueEnd < 0) return null;
    entries.push({ key, keyStart, valueStart, valueEnd });
    i = skipWs(raw, valueEnd);
    if (raw[i] === ',') { i++; continue; }
    if (raw[i] === '}') return { open, close: i, entries };
    return null;
  }
}

/** `JSON.stringify` at the file's unit, every line after the first prefixed by the key's own indentation. */
function renderValue(value: unknown, unit: string, base: string, eol: string): string {
  return JSON.stringify(value, null, unit).split('\n').map((line, idx) => (idx === 0 ? line : base + line)).join(eol);
}

/** The whitespace run that precedes `at` on its own line. */
function lineIndentBefore(raw: string, at: number): string {
  let i = at;
  while (i > 0 && (raw[i - 1] === ' ' || raw[i - 1] === '\t')) i--;
  return raw.slice(i, at);
}

/**
 * The file's text with its `hooks` value replaced (`value` an object),
 * inserted as the last key when absent, or removed (`value` null) — every
 * other byte unchanged. Falls back to a whole-file render when the text
 * cannot be walked, which a file that JSON.parse accepted practically never is.
 */
export function spliceHooks(file: ReadSettings, value: Record<string, unknown> | null): string {
  const { raw, indent: unit, eol } = file;
  if (!file.exists || !raw.trim()) {
    if (value === null) return raw;
    return `${JSON.stringify({ hooks: value }, null, unit).replace(/\n/g, eol)}${file.trailingNewline ? eol : ''}`;
  }
  const scan = scanTopLevel(raw);
  if (!scan) {
    const json: Settings = { ...file.json };
    if (value === null) delete json.hooks; else json.hooks = value;
    return `${JSON.stringify(json, null, unit).replace(/\n/g, eol)}${file.trailingNewline ? eol : ''}`;
  }
  const idx = scan.entries.findIndex((entry) => entry.key === 'hooks');
  const entry = idx >= 0 ? scan.entries[idx] : null;
  if (value !== null) {
    if (entry) {
      const base = lineIndentBefore(raw, entry.keyStart);
      return raw.slice(0, entry.valueStart) + renderValue(value, unit, base, eol) + raw.slice(entry.valueEnd);
    }
    const rendered = renderValue(value, unit, unit, eol);
    if (!scan.entries.length) {
      return `${raw.slice(0, scan.open + 1)}${eol}${unit}"hooks": ${rendered}${eol}${raw.slice(scan.close)}`;
    }
    const last = scan.entries[scan.entries.length - 1];
    const base = lineIndentBefore(raw, last.keyStart);
    return `${raw.slice(0, last.valueEnd)},${eol}${base}"hooks": ${renderValue(value, unit, base, eol)}${raw.slice(last.valueEnd)}`;
  }
  if (!entry) return raw;
  if (scan.entries.length === 1) return `${raw.slice(0, scan.open + 1)}${raw.slice(scan.close)}`;
  if (idx === scan.entries.length - 1) {
    const prev = scan.entries[idx - 1];
    return raw.slice(0, prev.valueEnd) + raw.slice(entry.valueEnd);
  }
  const next = scan.entries[idx + 1];
  return raw.slice(0, entry.keyStart) + raw.slice(next.keyStart);
}

function writeAtomic(path: string, text: string, mode: number | undefined): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, text, 'utf8');
  if (mode != null) { try { chmodSync(tmp, mode); } catch { /* keep the default */ } }
  renameSync(tmp, path);
}

/* ------------------------------------------------------------------ *
 * Status, install, uninstall
 * ------------------------------------------------------------------ */

function statusOf(file: ReadSettings, path: string, skillDir: string, env: NodeJS.ProcessEnv = process.env): HooksStatus {
  const command = hookCommand(skillDir, env);
  const events = {} as Record<HookEvent, boolean>;
  let stale = false;
  let current = 0;
  let briefWait = false;
  const hooks = (file.json.hooks && typeof file.json.hooks === 'object' ? file.json.hooks : {}) as Record<string, unknown>;
  for (const event of HOOK_EVENTS) {
    const groups = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    const ours = groups.filter(groupIsOurs);
    events[event] = ours.length > 0;
    const exact = ours.some((group) => (group.hooks ?? []).some((hook) => hook.command === command));
    if (exact) current++;
    else if (ours.length) stale = true;
    if (event === 'SessionStart') {
      briefWait = ours.some((group) => (group.hooks ?? []).some((hook) => hook.command === command
        && typeof hook.timeout === 'number' && hook.timeout >= HOOK_BRIEF_TIMEOUT_SECONDS));
    }
  }
  const have = HOOK_EVENTS.filter((event) => events[event]).length;
  const installed = current === HOOK_EVENTS.length && !stale;
  const partial = !installed && (have > 0 || stale);
  const plugin = installedPluginHooks(dirname(path));
  const viaPlugin = plugin?.carries === true;
  return {
    path, exists: file.exists, installed, partial,
    events, command, stale,
    brief: (installed && briefWait) || (viaPlugin && !installed && !partial && plugin!.brief),
    viaPlugin,
    ...(file.parseError ? { parseError: file.parseError } : {}),
  };
}

/** What is installed, without writing anything. */
export function hooksStatus(options: HooksOptions): HooksStatus {
  const path = options.settingsPath ?? defaultSettingsPath(options.env);
  return statusOf(readSettingsFile(path), path, options.skillDir, options.env);
}

export type HooksWrite = {
  ok: true; path: string; changed: boolean; status: HooksStatus;
  /** Nothing was spliced because the dir's installed plugin carries the hooks itself (`splice` off). */
  pluginCarries?: boolean;
};

function refuseUnparsed(path: string, file: ReadSettings): void {
  if (file.parseError) {
    throw new Error(`${path} does not parse as JSON (${file.parseError}) — fix or move it; nothing was written.`);
  }
}

/**
 * Add (or refresh) the four entries. Every other key and every other hook
 * group is carried through unchanged; an entry of ours that already points at
 * this checkout is left alone, one that points elsewhere is rewritten in place.
 * A file that does not parse is refused — the one thing worse than a missing
 * hook is a settings file the operator has to restore from memory.
 */
export function installHooks(options: HooksOptions): HooksWrite {
  const path = options.settingsPath ?? defaultSettingsPath(options.env);
  const file = readSettingsFile(path);
  refuseUnparsed(path, file);
  if (!options.splice && installedPluginHooks(dirname(path))?.carries) {
    return { ok: true, path, changed: false, pluginCarries: true, status: statusOf(file, path, options.skillDir, options.env) };
  }
  const hooks = (file.json.hooks && typeof file.json.hooks === 'object' && !Array.isArray(file.json.hooks)
    ? { ...(file.json.hooks as Record<string, unknown>) }
    : {}) as Record<string, unknown>;
  let changed = false;
  for (const event of HOOK_EVENTS) {
    const wanted = hookEntry(options.skillDir, options.env, event);
    const groups = Array.isArray(hooks[event]) ? [...(hooks[event] as unknown[])] : [];
    let placed = false;
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      if (!groupIsOurs(group)) continue;
      // Refresh in place: the path of this checkout, the timeout we ship.
      const next = {
        ...group,
        hooks: (group.hooks ?? []).map((hook) => (isOurs(hook.command) && !placed
          ? (placed = true, { ...hook, ...wanted })
          : hook)),
      };
      if (JSON.stringify(next) !== JSON.stringify(group)) { groups[i] = next; changed = true; }
    }
    if (!placed) { groups.push({ hooks: [wanted] }); changed = true; }
    hooks[event] = groups;
  }
  if (changed || !file.exists) writeAtomic(path, spliceHooks(file, hooks), file.mode ?? options.mode);
  return { ok: true, path, changed: changed || !file.exists, status: statusOf(readSettingsFile(path), path, options.skillDir, options.env) };
}

/**
 * Remove every group of ours. An event left with no groups loses its key; a
 * `hooks` object left empty is removed — so install → uninstall on a file that
 * had no hooks gives back the bytes it started with.
 */
export function uninstallHooks(options: HooksOptions): HooksWrite {
  const path = options.settingsPath ?? defaultSettingsPath(options.env);
  const file = readSettingsFile(path);
  if (!file.exists) return { ok: true, path, changed: false, status: statusOf(file, path, options.skillDir, options.env) };
  refuseUnparsed(path, file);
  const hooks = (file.json.hooks && typeof file.json.hooks === 'object' && !Array.isArray(file.json.hooks)
    ? { ...(file.json.hooks as Record<string, unknown>) }
    : null);
  let changed = false;
  if (hooks) {
    for (const event of Object.keys(hooks)) {
      const groups = hooks[event];
      if (!Array.isArray(groups)) continue;
      const kept = groups.filter((group) => !groupIsOurs(group));
      if (kept.length !== groups.length) {
        changed = true;
        if (kept.length) hooks[event] = kept; else delete hooks[event];
      }
    }
    if (changed) writeAtomic(path, spliceHooks(file, Object.keys(hooks).length ? hooks : null), file.mode);
  }
  return { ok: true, path, changed, status: statusOf(readSettingsFile(path), path, options.skillDir, options.env) };
}

/* ------------------------------------------------------------------ *
 * The plugin's own hooks — the verifier (measured-console phase 10)
 * ------------------------------------------------------------------ */

/** Where a plugin tree carries its hooks; Claude Code loads the file by its place. */
export const PLUGIN_HOOKS_REL = 'hooks/hooks.json';
/** The command every presence entry of the plugin runs — the plugin's own script, wherever the CLI cached it. */
export const PLUGIN_HOOK_COMMAND = 'bash "${CLAUDE_PLUGIN_ROOT}/scripts/session-hook.sh"';

export type PluginHooksStatus = {
  /** The `hooks/hooks.json` consulted. */
  path: string;
  exists: boolean;
  /** Every event has the plugin's presence entry, at the timeout this console ships. */
  carries: boolean;
  events: Record<HookEvent, boolean>;
  /** SessionStart waits long enough for the brief. */
  brief: boolean;
  /** What is wrong, one line each, when `carries` is false. */
  problems: string[];
};

/**
 * Does a plugin tree carry the presence hooks — the four events, each running
 * `${CLAUDE_PLUGIN_ROOT}/scripts/session-hook.sh` at its shipped timeout, under
 * the file's top-level `hooks` key (a file of the bare event map does not load).
 */
export function pluginHooksStatus(pluginRoot: string): PluginHooksStatus {
  const path = join(pluginRoot, PLUGIN_HOOKS_REL);
  const events = Object.fromEntries(HOOK_EVENTS.map((event) => [event, false])) as Record<HookEvent, boolean>;
  const problems: string[] = [];
  if (!existsSync(path)) {
    return { path, exists: false, carries: false, events, brief: false, problems: [`${path} does not exist`] };
  }
  let doc: unknown;
  try { doc = JSON.parse(readFileSync(path, 'utf8')); } catch (error) {
    return { path, exists: true, carries: false, events, brief: false, problems: [`${path} does not parse (${(error as Error).message})`] };
  }
  const hooks = (doc as { hooks?: unknown })?.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) {
    return { path, exists: true, carries: false, events, brief: false, problems: [`${path} has no top-level "hooks" object`] };
  }
  let brief = false;
  for (const event of HOOK_EVENTS) {
    const groups = (hooks as Record<string, unknown>)[event];
    const entries = (Array.isArray(groups) ? groups : [])
      .flatMap((group) => (group && typeof group === 'object' && Array.isArray((group as HookGroup).hooks) ? (group as HookGroup).hooks! : []));
    const ours = entries.filter((hook) => hook?.type === 'command' && hook.command === PLUGIN_HOOK_COMMAND);
    const timed = ours.some((hook) => hook.timeout === hookTimeoutFor(event));
    events[event] = ours.length > 0;
    if (!ours.length) problems.push(`${event}: no entry runs ${PLUGIN_HOOK_COMMAND}`);
    else if (!timed) problems.push(`${event}: the entry's timeout is not ${hookTimeoutFor(event)} s`);
    if (event === 'SessionStart') brief = ours.some((hook) => typeof hook.timeout === 'number' && hook.timeout >= HOOK_BRIEF_TIMEOUT_SECONDS);
  }
  return { path, exists: true, carries: problems.length === 0, events, brief, problems };
}

/** The hooks of the skill plugin one config dir has INSTALLED (its user-scope copy); null when none is installed. */
export function installedPluginHooks(configDir: string): PluginHooksStatus | null {
  let installPath: string | null = null;
  try { installPath = readSkillCopy(configDir).install?.installPath ?? null; } catch { installPath = null; }
  return installPath ? pluginHooksStatus(installPath) : null;
}

export type ConfigDirHooks = {
  configDir: string;
  /** The installed plugin's hooks; null when the plugin is not installed in this dir. */
  plugin: PluginHooksStatus | null;
  /** The settings file's spliced entries. */
  settings: HooksStatus;
  /**
   * `plugin` — the plugin carries the hooks and nothing is spliced (the
   * target) · `both` — the plugin carries them and the settings still have
   * the splice: the plugin's copy steps aside, and `uninstall-hooks` is the
   * tidy-up · `spliced` — only the settings carry them (a plugin from before
   * the hooks shipped in it, or none) · `missing` — neither does.
   */
  verdict: 'plugin' | 'both' | 'spliced' | 'missing';
};

/** What answers the presence events in one config dir — the plugin, the splice, both or neither. */
export function verifyHooks(configDir: string, skillDir: string, env: NodeJS.ProcessEnv = process.env): ConfigDirHooks {
  const plugin = installedPluginHooks(configDir);
  const settings = hooksStatus({ skillDir, settingsPath: join(configDir, 'settings.json'), env });
  const spliced = settings.installed || settings.partial;
  const verdict = plugin?.carries ? (spliced ? 'both' : 'plugin') : (settings.installed ? 'spliced' : 'missing');
  return { configDir, plugin, settings, verdict };
}

/* ------------------------------------------------------------------ *
 * Every hook, read-only (measured-console phase 28, D3)
 * ------------------------------------------------------------------ */

/** Where a hook comes from: the console's plugin, the user's settings, the project's, or a run's own `--settings`. */
export const HOOK_SOURCES = ['plugin', 'user', 'project', 'run'] as const;
export type HookSource = (typeof HOOK_SOURCES)[number];

/** One hook as Settings ▸ Hooks draws it. */
export type HookRow = {
  source: HookSource;
  /** The file it was read from (`~`-relative is the page's business). */
  file: string;
  event: string;
  matcher?: string;
  type: string;
  /** The command or URL it runs — a bearer is never carried, only its header's name. */
  runs: string;
  /** Seconds; absent is the CLI's own default. */
  timeout?: number;
  /** `block` — a hook that cannot start, times out or answers garbage blocks the call; absent is the CLI's default (it carries on). */
  onFailure?: string;
  /** When it is there at all — a run's conditional hooks say which runs carry them. */
  when?: string;
};

/**
 * The hooks one settings-shaped document names, flattened to rows — a
 * `settings.json`, a plugin's `hooks/hooks.json`, or a run's settings.
 * Read-only: nothing here writes, and an `Authorization` value never leaves.
 */
export function hookRowsOf(doc: unknown, source: HookSource, file: string, when?: (event: string, hook: Record<string, unknown>) => string | undefined): HookRow[] {
  const hooks = (doc as { hooks?: unknown } | null)?.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return [];
  const rows: HookRow[] = [];
  for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
    for (const group of Array.isArray(groups) ? groups : []) {
      if (!group || typeof group !== 'object') continue;
      const matcher = (group as { matcher?: unknown }).matcher;
      for (const raw of Array.isArray((group as HookGroup).hooks) ? (group as HookGroup).hooks! : []) {
        const hook = raw as unknown as Record<string, unknown>;
        const type = typeof hook.type === 'string' ? hook.type : 'command';
        const runs = typeof hook.command === 'string' ? hook.command
          : typeof hook.url === 'string' ? hook.url
            : typeof hook.prompt === 'string' ? hook.prompt.slice(0, 200) : '';
        const said = when?.(event, hook);
        rows.push({
          source, file, event, type, runs,
          ...(typeof matcher === 'string' && matcher ? { matcher } : {}),
          ...(typeof hook.timeout === 'number' ? { timeout: hook.timeout } : {}),
          ...(typeof hook.onFailure === 'string' ? { onFailure: hook.onFailure } : {}),
          ...(said ? { when: said } : {}),
        });
      }
    }
  }
  return rows;
}

/** A settings file's hooks, or none — a file that does not parse is no hooks, said by its absence. */
export function hookRowsOfFile(file: string, source: HookSource): HookRow[] {
  if (!existsSync(file)) return [];
  try { return hookRowsOf(JSON.parse(readFileSync(file, 'utf8')), source, file); } catch { return []; }
}
