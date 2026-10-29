/**
 * The ONE reader of Claude Code's `<plugins root>/installed_plugins.json`
 * (measured-console phase 10, the audit's EI-26).
 *
 * Two modules read that file — `server/skill-copy.ts` (which commit of THIS
 * skill a config dir loads) and `server/skills.ts` (every installed plugin's
 * skills, for the boot prompt's list) — and each had its own idea of its
 * shape: one read version 1's single record per id and version 2's list, the
 * other only the list, so a version-1 registry listed no plugin skills at all.
 * This is the shape, once:
 *
 *   version 1  {"version":1,"plugins":{"<plugin>@<market>": {record}}}
 *   version 2  {"version":2,"plugins":{"<plugin>@<market>": [{record}, …]}}
 *
 * where a record carries `scope` (user · project · local; absent reads
 * `user`), `installPath`, `version`, `gitCommitSha`, `installedAt`,
 * `lastUpdated` and, for a project scope, `projectPath`. A record with no
 * `installPath` is not an install. Pure: the caller reads the text (a leaf,
 * dependency-free, like everything under `shared/`).
 */

/**
 * @typedef {object} InstalledPlugin
 * @property {string} id           `<plugin>@<marketplace>` as Claude Code keys it
 * @property {string} plugin       the part before `@` — the skills' invocation prefix
 * @property {string} marketplace  the part after `@` (empty when the key has none)
 * @property {string} scope
 * @property {string} installPath
 * @property {string|null} version
 * @property {string|null} commit       `gitCommitSha`
 * @property {string|null} lastUpdated
 * @property {string} [projectPath]
 */

/**
 * Every install a registry's text names, in file order.
 * @param {string} text
 * @returns {{ installs: InstalledPlugin[], fileVersion: number|null, parseError?: string }}
 */
export function parseInstalledPlugins(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    return { installs: [], fileVersion: null, parseError: String(error?.message ?? error) };
  }
  const fileVersion = typeof doc?.version === 'number' ? doc.version : null;
  const plugins = doc?.plugins;
  if (!plugins || typeof plugins !== 'object' || Array.isArray(plugins)) return { installs: [], fileVersion };
  /** @type {InstalledPlugin[]} */
  const installs = [];
  for (const [id, raw] of Object.entries(plugins)) {
    const at = id.indexOf('@');
    const plugin = at >= 0 ? id.slice(0, at) : id;
    const marketplace = at >= 0 ? id.slice(at + 1) : '';
    if (!plugin) continue;
    // Version 2 keys a LIST of installs (one per scope); version 1 keyed one.
    for (const entry of Array.isArray(raw) ? raw : raw ? [raw] : []) {
      if (!entry || typeof entry !== 'object' || typeof entry.installPath !== 'string' || !entry.installPath)
        continue;
      installs.push({
        id,
        plugin,
        marketplace,
        scope: typeof entry.scope === 'string' && entry.scope ? entry.scope : 'user',
        installPath: entry.installPath,
        version: typeof entry.version === 'string' ? entry.version : null,
        commit: typeof entry.gitCommitSha === 'string' ? entry.gitCommitSha : null,
        lastUpdated:
          typeof entry.lastUpdated === 'string'
            ? entry.lastUpdated
            : typeof entry.installedAt === 'string'
              ? entry.installedAt
              : null,
        ...(typeof entry.projectPath === 'string' ? { projectPath: entry.projectPath } : {}),
      });
    }
  }
  return { installs, fileVersion };
}

/**
 * The newest install of each plugin id (by `lastUpdated`, then file order) —
 * the one a session loads when a plugin was installed more than once.
 * @param {InstalledPlugin[]} installs
 * @returns {InstalledPlugin[]}
 */
export function newestPerPlugin(installs) {
  /** @type {Map<string, InstalledPlugin>} */
  const best = new Map();
  for (const one of installs) {
    const had = best.get(one.id);
    if (!had || String(one.lastUpdated ?? '').localeCompare(String(had.lastUpdated ?? '')) > 0)
      best.set(one.id, one);
  }
  return [...best.values()];
}
