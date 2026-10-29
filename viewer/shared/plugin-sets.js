/**
 * Per-phase plugin sets (measured-console phase 27, D5): the kinds a plan or a
 * phase may name — `- **Plugins:** review` on a phase, `**Plugins:** docs` on
 * §Session budget, UNIONED and never across phases — and what each kind
 * brings into that phase's session.
 *
 * ONE owner. `scripts/plugin-sets.env` is its bash twin (the names alone, for
 * `phase-graph.sh --plugins` and F48), held to this table by
 * `test/plugin-sets.test.ts`; `server/parse/plan.ts` reads the bullet and the
 * line, `server/runner/loads.ts` resolves a set against what the session loads.
 *
 * An entry is a qualified name — `<plugin>@<marketplace>` for a whole plugin,
 * `<plugin>:<skill>` for one skill of it, a bare name for a skill no plugin
 * carries — with:
 *   - `edition`    — the console that offers it. The sets are Pro; the Free
 *                    console reads the bullet and resolves every kind to nothing.
 *   - `unattended` — what it needs to run with nobody at the keyboard
 *                    (`UNATTENDED_WORDS`).
 *   - `env`        — set in the session's environment when the entry loads.
 *   - `requires`   — an operator's one-time act, in words, for `operator-set`.
 */

/** The kinds, in the order a picker shows them. Free and Pro alike: a plan's bullet parses in both. */
export const PLUGIN_KINDS = Object.freeze(
  /** @type {const} */ (['review', 'security', 'planning', 'release', 'docs', 'ui']),
);

/**
 * What an entry needs to run unattended.
 *
 * `ready`        — runs as shipped.
 * `pinned`       — runs only with the `env` the entry names, which the console sets.
 * `plan-mode`    — an interactive planning skill: loaded only in a phase whose
 *                  permission mode is `plan`, skipped (and said) anywhere else.
 * `operator-set` — needs an operator's one-time act first (`requires`); the
 *                  console sets the `env` and names the act, it cannot do it.
 */
export const UNATTENDED_WORDS = Object.freeze(
  /** @type {const} */ (['ready', 'pinned', 'plan-mode', 'operator-set']),
);

/** The editions an entry can belong to. */
export const PLUGIN_EDITIONS = Object.freeze(/** @type {const} */ (['free', 'pro']));

/**
 * Why an entry of a phase's set did not load, in `phase.plugins`' `set.missing`.
 *
 * `not-installed`     — neither the seed nor the console's config dir carries its plugin.
 * `skill-not-carried` — its plugin loads, but without this skill (a seed entry's `skills` array).
 * `plan-mode-only`    — a `plan-mode` entry on a phase that does not start in plan mode.
 */
export const PLUGIN_MISSING_REASONS = Object.freeze(
  /** @type {const} */ (['not-installed', 'skill-not-carried', 'plan-mode-only']),
);

/**
 * Where one line of Settings ▸ Skills & plugins stands (measured-console phase
 * 28, F1) — a skill, an installed plugin, a seed entry or a catalog entry.
 *
 * `installed` — in the console's config dir, and not enabled in its settings.
 * `seeded`    — carried by the machine's plugin seed, which every session loads.
 * `enabled`   — installed and enabled in the config dir's own settings (a person's sessions load it).
 * `autopilot` — installed and switched on for unattended sessions (`autopilotPlugins`).
 * `stale`     — installed, but its marketplace lists a newer version; or a seed older than 30 days.
 * `missing`   — named (by the kinds table, or by `autopilotPlugins`) and not installed.
 */
export const SKILL_STATES = Object.freeze(
  /** @type {const} */ (['installed', 'seeded', 'enabled', 'autopilot', 'stale', 'missing']),
);

/**
 * The listing budget (F48 `plugin-set-over-budget`): the CLI lists each skill
 * a session loads in its context, and budgets that listing at 1 % of the
 * window, an entry's description cut at 1,536 characters. A phase's set is
 * costed at that ceiling — entries × `ENTRY_CHARS` — against 1 % of its
 * model's window at `CHARS_PER_TOKEN` (200 K, or 1 M with `[1m]`): 8,000
 * characters, five entries, on a 200 K window. Advisory, like F47.
 */
export const PLUGIN_LISTING = Object.freeze({
  pct: 1,
  entryChars: 1536,
  charsPerToken: 4,
  window: 200_000,
  window1m: 1_000_000,
});

/**
 * @typedef {{
 *   name: string,
 *   edition: (typeof PLUGIN_EDITIONS)[number],
 *   unattended: (typeof UNATTENDED_WORDS)[number],
 *   env?: Readonly<Record<string, string>>,
 *   requires?: string,
 * }} PluginEntry
 */

/** @type {Readonly<Record<(typeof PLUGIN_KINDS)[number], readonly PluginEntry[]>>} */
export const PLUGIN_SETS = Object.freeze({
  review: Object.freeze([
  ]),
  security: Object.freeze([
  ]),
  planning: Object.freeze([
  ]),
  release: Object.freeze([
  ]),
  docs: Object.freeze([
  ]),
  ui: Object.freeze([
  ]),
});

/** Whether `word` is a kind. */
export function isPluginKind(word) {
  return typeof word === 'string' && /** @type {readonly string[]} */ (PLUGIN_KINDS).includes(word);
}

/**
 * The words of a `**Plugins:**` line or bullet: backticks dropped, split on
 * commas and spaces, lower-cased, deduped in first-seen order. Kinds and
 * unknown words alike — `pluginKindsOf` keeps the kinds, F48 names the rest.
 *
 * @param {string | undefined} body
 * @returns {string[]}
 */
export function pluginWordsOf(body) {
  if (!body) return [];
  const words = body
    .replace(/`/g, ' ')
    .split(/[\s,]+/)
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(words)];
}

/** @param {readonly string[]} words */
export function pluginKindsOf(words) {
  return words.filter(isPluginKind);
}

/**
 * Every entry the kinds bring, deduped by name in first-seen order — the set
 * one phase's session is given. Never a union across phases.
 *
 * @param {readonly string[]} kinds
 * @returns {PluginEntry[]}
 */
export function pluginEntriesFor(kinds) {
  /** @type {Map<string, PluginEntry>} */
  const out = new Map();
  for (const kind of kinds) {
    if (!isPluginKind(kind)) continue;
    for (const entry of PLUGIN_SETS[kind]) if (!out.has(entry.name)) out.set(entry.name, entry);
  }
  return [...out.values()];
}

/**
 * The plugin an entry belongs to: before `@` or `:`; a bare skill name has none.
 *
 * @param {string} name
 * @returns {string | null}
 */
export function entryPlugin(name) {
  const at = name.indexOf('@');
  if (at > 0) return name.slice(0, at);
  const colon = name.indexOf(':');
  return colon > 0 ? name.slice(0, colon) : null;
}

/** @param {string} name — whether the entry names one skill rather than a whole plugin. */
export function entryIsSkill(name) {
  return !name.includes('@');
}

/**
 * The listing budget of one set, in characters: what it costs and what it may.
 *
 * @param {number} entries
 * @param {string | undefined} model — the phase's model; a `[1m]` suffix is the 1 M window
 * @returns {{ cost: number, budget: number, over: boolean }}
 */
export function pluginListingBudget(entries, model) {
  const window =
    model && model.toLowerCase().endsWith('[1m]') ? PLUGIN_LISTING.window1m : PLUGIN_LISTING.window;
  const budget = Math.floor((window * PLUGIN_LISTING.pct * PLUGIN_LISTING.charsPerToken) / 100);
  const cost = entries * PLUGIN_LISTING.entryChars;
  return { cost, budget, over: cost > budget };
}
