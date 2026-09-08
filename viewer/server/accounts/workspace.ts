/**
 * What a profile's config dir must hold before a session can boot in it.
 *
 * A `profile` account runs its children under `CLAUDE_CONFIG_DIR`, and moving
 * the config home moves everything the CLI resolves from it — including the
 * user's skills directory, the plugin registry, the settings that enable the
 * plugins, and the workspace-trust ledger. Measured on 2026-08-26
 * (state-path-hardening phase 10, run 24698b8d, and console-speed phase 2
 * before it): a phase session spawned under a profile printed
 * `Unknown command: /phased-execution` and exited success with 0 turns —
 * `~/.claude/skills` simply does not exist from inside a bare profile dir —
 * and warned `Ignoring 15 permissions.allow entries … this workspace has not
 * been trusted`, because the profile's own `.claude.json` had never accepted
 * the trust dialog for the root the runner spawns in. The ladder then burned
 * attempts re-boarding a session that could never have worked.
 *
 * Measured again on 2026-09-07 (qa-loops WP10): with `skills` linked,
 * `/phased-execution` boards under every profile — but every plugin skill a
 * plan names (`superpowers`, `code-review`, `feature-dev`,
 * `frontend-design:frontend-design`) was absent from every profile-spawned
 * session. Two causes, one per file: the profile's `plugins/` was the empty
 * registry the CLI makes for itself on first launch, which SHADOWS the login's
 * — the profile "has" plugins, none of them — and its `settings.json` (absent,
 * or holding only `theme`) named no `enabledPlugins`, so even a linked
 * registry would have been installed-and-off.
 *
 * So the console provisions four things itself, idempotently, at the same
 * moment it hands out the env (`Accounts.envFor`):
 *
 *  · `<config>/skills` → a symlink to the machine login's skills directory,
 *    so every skill a boot prompt names exists under the profile too. Never
 *    overwrites: a real directory (an operator's deliberate per-profile skill
 *    set) is left exactly as found.
 *  · `<config>/plugins` → a symlink to the login's plugin registry. The CLI's
 *    own empty registry is moved aside as `plugins.unused-<stamp>` — never
 *    deleted, so a wrong call costs one rename — and replaced; a registry with
 *    anything in it (a plugin installed, a marketplace a person added) is the
 *    operator's and is left exactly as found.
 *  · `enabledPlugins` and `extraKnownMarketplaces` from the login's
 *    `settings.json`, into the profile's — only the keys the profile lacks,
 *    and only those two; every other key stays whatever it is.
 *  · `hasTrustDialogAccepted: true` for each root the runner will spawn in,
 *    merged into the profile's `.claude.json` — the same edit the CLI's own
 *    error message tells a person to make by hand.
 *
 * Fail-open on purpose: provisioning is a convenience the spawn must never
 * die on. A failure logs and the session boots as it would have before —
 * degraded, but no worse than yesterday. The plugins and settings steps each
 * fail open on their own, so neither can cost the trust write that comes
 * after them.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { log } from '../log.ts';

/**
 * The marketplace the CLI registers by itself the first time it runs in a
 * config dir. Measured 2026-09-07: both profiles under
 * `phase-console/accounts/{account,info}/config/plugins/` held
 * `installed_plugins.json` `{"version":2,"plugins":{}}` and a
 * `known_marketplaces.json` naming exactly this one — nobody added it, so it
 * is part of the empty baseline, not content. A rule that read "no
 * marketplaces at all" would have kept both of those registries and fixed
 * nothing on the machine the incident was measured on.
 */
const CLI_REGISTERED_MARKETPLACES: ReadonlySet<string> = new Set(['claude-plugins-official']);

/**
 * The `settings.json` keys a profile inherits from the login when it lacks
 * them. Exactly these two: `permissions`, `hooks`, `model` and `env` are the
 * login's own business, and a run's are set by the console's policy files.
 */
const INHERITED_SETTINGS = ['enabledPlugins', 'extraKnownMarketplaces'] as const;

export function ensureProfileWorkspace(
  configDir: string,
  trustRoots: string[],
  skillsSource: string = join(homedir(), '.claude', 'skills'),
  loginDir: string = join(homedir(), '.claude'),
): void {
  try {
    mkdirSync(configDir, { recursive: true });

    const link = join(configDir, 'skills');
    let present = false;
    try { lstatSync(link); present = true; } catch { /* nothing there — ours to create */ }
    if (!present && existsSync(skillsSource)) {
      symlinkSync(skillsSource, link);
      log.info('accounts.workspace.skills-linked', { configDir, to: skillsSource });
    }

    linkPlugins(configDir, join(loginDir, 'plugins'));
    inheritPluginSettings(configDir, join(loginDir, 'settings.json'));

    if (trustRoots.length) {
      const file = join(configDir, '.claude.json');
      let parsed: Record<string, unknown> = {};
      try { parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>; } catch { /* absent or unreadable — start empty */ }
      const projects = (parsed.projects ??= {}) as Record<string, Record<string, unknown>>;
      let changed = false;
      for (const root of trustRoots) {
        const entry = (projects[root] ??= {});
        if (entry.hasTrustDialogAccepted !== true) {
          entry.hasTrustDialogAccepted = true;
          changed = true;
        }
      }
      if (changed) {
        // Atomic and private, like every other file under the accounts dir.
        const tmp = `${file}.tmp`;
        writeFileSync(tmp, JSON.stringify(parsed, null, 2), { mode: 0o600 });
        renameSync(tmp, file);
        log.info('accounts.workspace.trusted', { configDir, roots: trustRoots });
      }
    }
  } catch (error) {
    log.warn('accounts.workspace.failed', { configDir, error: (error as Error).message });
  }
}

/**
 * `<config>/plugins` → the login's registry. Anything already there that is
 * not the CLI's empty registry — a symlink (ours from last time, or a
 * person's), a file, a registry with content — is left exactly as found, so a
 * second run is a no-op and an operator's per-profile choice survives.
 */
function linkPlugins(configDir: string, source: string): void {
  try {
    if (!existsSync(source)) return; // a login that never used plugins has nothing to offer
    const link = join(configDir, 'plugins');
    let found: ReturnType<typeof lstatSync> | undefined;
    try { found = lstatSync(link); } catch { /* nothing there — ours to create */ }
    if (found) {
      if (!found.isDirectory() || !isEmptyCliRegistry(link)) return;
      // Moved, never removed: the stamp keeps two moves apart and tells a
      // person reading the directory when the console did it.
      const aside = `${link}.unused-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      renameSync(link, aside);
      log.info('accounts.workspace.plugins-moved-aside', { configDir, to: aside });
    }
    symlinkSync(source, link);
    log.info('accounts.workspace.plugins-linked', { configDir, to: source });
  } catch (error) {
    log.warn('accounts.workspace.plugins-failed', { configDir, error: (error as Error).message });
  }
}

/**
 * The registry the CLI writes on its own: `installed_plugins.json` with no
 * plugin in it, and either no `known_marketplaces.json` or one naming only
 * what the CLI registers by itself. Anything else — a plugin, a marketplace a
 * person added, a file that does not parse, no `installed_plugins.json` at
 * all — is not a shape this code knows, and is therefore not its to move.
 */
function isEmptyCliRegistry(dir: string): boolean {
  const installed = readObject(join(dir, 'installed_plugins.json'));
  if (!installed) return false;
  const plugins = installed.plugins;
  const none = Array.isArray(plugins)
    ? plugins.length === 0
    : plugins !== null && typeof plugins === 'object' && Object.keys(plugins).length === 0;
  if (!none) return false;
  const marketplacesFile = join(dir, 'known_marketplaces.json');
  if (!existsSync(marketplacesFile)) return true;
  const known = readObject(marketplacesFile);
  return known !== undefined && Object.keys(known).every((name) => CLI_REGISTERED_MARKETPLACES.has(name));
}

/**
 * `enabledPlugins` and `extraKnownMarketplaces` from the login's
 * `settings.json` into the profile's, for the keys the profile lacks. A
 * profile file that does not parse is a person's to fix, never ours to
 * replace with `{}`; a login without a readable one has nothing to give.
 */
function inheritPluginSettings(configDir: string, loginSettings: string): void {
  try {
    const login = readObject(loginSettings);
    if (!login) return;
    const file = join(configDir, 'settings.json');
    let text: string | undefined;
    try { text = readFileSync(file, 'utf8'); } catch { /* absent — start empty */ }
    let profile: Record<string, unknown> = {};
    if (text !== undefined) {
      const parsed = parseObject(text);
      if (!parsed) {
        log.warn('accounts.workspace.settings-unreadable', { configDir });
        return;
      }
      profile = parsed;
    }
    const inherited = INHERITED_SETTINGS.filter((key) => !Object.hasOwn(profile, key) && login[key] !== undefined);
    if (!inherited.length) return; // the second run, and every run after it
    for (const key of inherited) profile[key] = login[key];
    // Atomic and private, like `.claude.json` above.
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(profile, null, 2), { mode: 0o600 });
    renameSync(tmp, file);
    log.info('accounts.workspace.settings-inherited', { configDir, keys: inherited });
  } catch (error) {
    log.warn('accounts.workspace.settings-failed', { configDir, error: (error as Error).message });
  }
}

/** A JSON file as a plain object — `undefined` when absent, unreadable, or not an object. */
function readObject(file: string): Record<string, unknown> | undefined {
  try { return parseObject(readFileSync(file, 'utf8')); } catch { return undefined; }
}

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch { return undefined; }
}
