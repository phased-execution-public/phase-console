/**
 * Which skills a phase could invoke.
 *
 * A plan can already name skills that every session must use — one line,
 * `**Skills (every session):**`, re-injected into every boot prompt by the
 * engine. That is the durable statement and it stays exactly as it is. What was
 * missing is everything around it: no way to see what is installed, no way to
 * turn one on for a single run, and no way to give one phase a skill the rest
 * of the plan has no use for.
 *
 * So this enumerates what the *child* would be able to invoke, from the same
 * Claude home the child will run in — the console can be started from any of
 * several homes and the session inherits its environment, so reading the wrong
 * one would offer skills that do not exist over there.
 *
 * Nothing here is authoritative about whether a skill will trigger; that is the
 * model's decision. It is authoritative about what may be *named*, which is
 * what a picker needs.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import { newestPerPlugin, parseInstalledPlugins } from '../shared/installed-plugins.js';
import { log } from './log.ts';
import { parseFrontMatter, scalar } from './parse/frontmatter.ts';
import { mcpReasonText, type McpDegradation } from './runner/state.ts';
import { graphDirFor, graphToolOf } from './runner/graph-refresh.ts';

export type SkillSource = 'personal' | 'project' | 'plugin';

export type SkillInfo = {
  /** What you would type after the slash: `name` or `plugin:name`. */
  id: string;
  name: string;
  description: string;
  source: SkillSource;
  /** For plugin skills, the plugin that supplies it. */
  plugin?: string;
  path: string;
};

/** A skill directory nested deeper than this is not a skill directory. */
const MAX_DEPTH = 3;
/** Enough to be cheap on a tab switch, short enough to notice a new install. */
const CACHE_MS = 30_000;

/**
 * The Claude home the spawned session will use.
 *
 * `CLAUDE_CONFIG_DIR` is what the child inherits, so it is what decides which
 * `skills/` directory exists for it — not the one this file happens to live in.
 */
export function claudeHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

/* ------------------------------------------------------------------ *
 * Reading one skill
 * ------------------------------------------------------------------ */

/**
 * A skill's own account of itself.
 *
 * The frontmatter `name` is what the model invokes, and it is not always the
 * directory name — so the directory is only the fallback. A description over a
 * line or two is truncated: this is a picker, not the skill.
 */
export function readSkill(file: string, source: SkillSource, plugin?: string): SkillInfo | null {
  let text: string;
  try { text = readFileSync(file, 'utf8').slice(0, 8_000); } catch { return null; }

  const { values } = parseFrontMatter(text);
  const raw = values.name;
  const name = scalar(typeof raw === 'string' ? raw : '') || basename(join(file, '..'));
  if (!name || !/^[\w.-]+$/.test(name)) return null;

  const described = values.description;
  const description = scalar(typeof described === 'string' ? described : '')
    .replace(/\s+/g, ' ')
    .slice(0, 300);

  return {
    id: plugin ? `${plugin}:${name}` : name,
    name,
    description,
    source,
    ...(plugin ? { plugin } : {}),
    path: file,
  };
}

/**
 * Every `SKILL.md` under a root, without descending forever.
 *
 * Dot-directories are skipped except `.claude`, because a real plugin on this
 * machine ships its skills at `<install>/.claude/skills/<name>/SKILL.md` and a
 * blanket dotfile skip made every one of them invisible.
 */
function findSkillFiles(root: string, depth = 0, found: string[] = []): string[] {
  if (depth > MAX_DEPTH || !existsSync(root)) return found;
  let entries: string[];
  try { entries = readdirSync(root); } catch { return found; }
  for (const entry of entries) {
    if (entry === 'node_modules') continue;
    if (entry.startsWith('.') && entry !== '.claude') continue;
    const full = join(root, entry);
    try {
      if (entry === 'SKILL.md') found.push(full);
      else if (statSync(full).isDirectory()) findSkillFiles(full, depth + 1, found);
    } catch { /* a file that vanished mid-walk is not a signal */ }
  }
  return found;
}

/**
 * Slash commands, which are invoked exactly like skills and are how several
 * plugins ship their entry point (`commands/feature-dev.md` →
 * `/feature-dev:feature-dev`). Their name comes from the FILENAME — the front
 * matter of a command carries a description and no name at all.
 */
function findCommandFiles(root: string): { file: string; name: string }[] {
  const dir = join(root, 'commands');
  if (!existsSync(dir)) return [];
  const out: { file: string; name: string }[] = [];
  const walk = (at: string, depth: number): void => {
    let entries: string[];
    try { entries = readdirSync(at); } catch { return; }
    for (const entry of entries) {
      if (entry.startsWith('.')) continue;
      const full = join(at, entry);
      try {
        if (statSync(full).isDirectory()) { if (depth < 2) walk(full, depth + 1); continue; }
      } catch { continue; }
      if (!entry.endsWith('.md')) continue;
      out.push({ file: full, name: entry.slice(0, -3) });
    }
  };
  walk(dir, 0);
  return out;
}

/** A command file, read as the skill it is invoked as. */
function readCommand(file: string, name: string, source: SkillSource, plugin?: string): SkillInfo | null {
  if (!/^[\w.-]+$/.test(name)) return null;
  let text: string;
  try { text = readFileSync(file, 'utf8').slice(0, 8_000); } catch { return null; }
  const { values } = parseFrontMatter(text);
  const described = values.description;
  return {
    id: plugin ? `${plugin}:${name}` : name,
    name,
    description: scalar(typeof described === 'string' ? described : '').replace(/\s+/g, ' ').slice(0, 300),
    source,
    ...(plugin ? { plugin } : {}),
    path: file,
  };
}

/* ------------------------------------------------------------------ *
 * Plugins
 * ------------------------------------------------------------------ */

/**
 * Installed plugins, by the path they were actually installed to.
 *
 * Globbing the cache directory would be wrong: several versions of the same
 * plugin sit there side by side, and only one of them is the one a session
 * would load. The install record says which — read by the one reader of
 * `installed_plugins.json` (`shared/installed-plugins.js`), which knows both
 * the version-1 and the version-2 shape.
 */
export function installedPlugins(home: string): { plugin: string; path: string }[] {
  let text: string;
  try { text = readFileSync(join(home, 'plugins', 'installed_plugins.json'), 'utf8'); }
  catch { return []; }
  // Newest install wins when a plugin was installed more than once.
  return newestPerPlugin(parseInstalledPlugins(text).installs)
    .filter((one) => existsSync(one.installPath))
    // `plugin@marketplace`; the invocation prefix is the plugin alone.
    .map((one) => ({ plugin: one.plugin, path: one.installPath }));
}

/* ------------------------------------------------------------------ *
 * Everything, once
 * ------------------------------------------------------------------ */

let cache: { at: number; home: string; root: string; value: SkillInfo[] } | null = null;

/**
 * Every skill a phase in this repo could invoke, sorted by where it comes from
 * and then by name. Duplicated ids are collapsed, keeping the more specific
 * source: a project skill shadows a personal one of the same name.
 */
export function listSkills(root: string | undefined, env: NodeJS.ProcessEnv = process.env): SkillInfo[] {
  const home = claudeHome(env);
  const key = root ?? '';
  if (cache && cache.home === home && cache.root === key && Date.now() - cache.at < CACHE_MS) {
    return cache.value;
  }

  const byId = new Map<string, SkillInfo>();
  const add = (skill: SkillInfo | null) => { if (skill && !byId.has(skill.id)) byId.set(skill.id, skill); };

  try {
    // Project first, so a repo's own version of a name is the one offered.
    if (root) {
      const project = join(root, '.claude');
      for (const file of findSkillFiles(join(project, 'skills'))) add(readSkill(file, 'project'));
      for (const { file, name } of findCommandFiles(project)) add(readCommand(file, name, 'project'));
    }
    for (const file of findSkillFiles(join(home, 'skills'))) add(readSkill(file, 'personal'));
    for (const { file, name } of findCommandFiles(home)) add(readCommand(file, name, 'personal'));
    for (const { plugin, path } of installedPlugins(home)) {
      for (const file of findSkillFiles(path)) add(readSkill(file, 'plugin', plugin));
      for (const { file, name } of findCommandFiles(path)) add(readCommand(file, name, 'plugin', plugin));
    }
  } catch (error) {
    log.warn('skills.scan', { error });
  }

  const order: Record<SkillSource, number> = { project: 0, personal: 1, plugin: 2 };
  const value = [...byId.values()].sort((a, b) =>
    order[a.source] - order[b.source] || a.id.localeCompare(b.id));

  cache = { at: Date.now(), home, root: key, value };
  return value;
}

export function forgetSkills(): void { cache = null; }

/**
 * What a session should do with a per-repository knowledge graph — said only
 * when one is FRESH (measured-console phase 11, the audit's D6).
 *
 * Such a graph is worth almost nothing if it is only ever written: the value is
 * in querying it at the START of a session, when not knowing where something
 * lives costs the most, and refreshing it at the end. But a graph older than
 * the last change that landed in its repository answers about a tree that is
 * gone, and the directive used to ride every list of skills whatever the graph's
 * age. So it is emitted only for a repository whose `<tool>-out/graph.json` is
 * newer than its last landing, and the landing engine refreshes the graph when
 * it lands (`runner/graph-refresh.ts`). WHICH tool is the console's `graphTool`
 * setting — empty, the shipped default, is off — and the directive names the
 * repositories, never the tool.
 */

/**
 * The repository's last landing, as a time: the commit time of its HEAD — the
 * newest work the graph would have to know about. Null when git cannot say.
 */
function landedAtMs(repo: string): number | null {
  try {
    const out = execFileSync('git', ['-C', repo, 'log', '-1', '--format=%ct', 'HEAD'], {
      encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const seconds = Number(out);
    return out && Number.isFinite(seconds) ? seconds * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * Whether a repository's knowledge graph (the `tool`'s) is newer than its last
 * landing. `graphAtMs` and `landedAtMs` are the two times compared.
 */
export function graphFreshness(repo: string, tool: string): { fresh: boolean; graphAtMs?: number; landedAtMs?: number } {
  const name = graphToolOf(tool);
  if (!name) return { fresh: false };
  let graphAtMs: number;
  try { graphAtMs = statSync(join(repo, graphDirFor(name), 'graph.json')).mtimeMs; } catch { return { fresh: false }; }
  const landed = landedAtMs(repo);
  // A repository git cannot date has nothing to be stale against.
  if (landed === null) return { fresh: true, graphAtMs };
  return { fresh: graphAtMs > landed, graphAtMs, landedAtMs: landed };
}

/** The repositories among `repos` whose graph is fresh, in the order given, once each; none with no tool named. */
export function freshGraphs(repos: readonly string[], tool: string): string[] {
  return [...new Set(repos)].filter((repo) => graphFreshness(repo, tool).fresh);
}

/** The directive for the fresh graphs, named as the caller wants them read (relative paths); empty with none. */
export function knowledgeGraphDirective(named: readonly string[]): string {
  const repos = [...new Set(named.filter(Boolean))];
  if (!repos.length) return '';
  return `\nA per-repository knowledge graph newer than the last landing is kept in ${repos.map((r) => `\`${r}\``).join(', ')}: `
    + 'at session START, query it for each repository this phase touches — run the query from inside that '
    + 'repository — and refresh/update the graph there before your handoff.\n';
}

/**
 * The ONE line a skill is named in (measured-console phase 11, §Architecture
 * 12 "delivery, not presence"): a Skill-tool call by the name the tool takes,
 * per skill — the engine's boot-prompt line has the same shape
 * (`skill_calls_line` in phase-graph.sh). Empty for none.
 */
export function skillCallsLine(names: readonly string[]): string {
  const named = [...new Set(names.filter(Boolean))];
  return named.length ? named.map((name) => `Call the Skill tool with "${name}".`).join(' ') : '';
}

/**
 * The name the Skill tool is called with — `skill_qualify` in phase-graph.sh:
 * as written when it names its plugin, else the ONE skill of that name in
 * `loaded` (the console's resolved set, `PE_SKILLS`' words with their `!`),
 * qualified by its plugin, else as written.
 */
export function qualifySkill(name: string, loaded: readonly string[]): string {
  if (name.includes(':')) return name;
  const hits = loaded.map((token) => token.replace(/!$/, '')).filter((token) => token === name || token.endsWith(`:${name}`));
  return hits.length === 1 ? hits[0]! : name;
}

/**
 * The line appended to a boot prompt for skills chosen in the console.
 *
 * Deliberately additive and deliberately separate from the engine's own text:
 * `phase-graph.sh` remains the only thing that decides what a boot prompt says
 * about the *plan*, including the plan's own skills line. This is the operator
 * adding to it for one run, and it reads as that — in the engine line's shape,
 * a Skill-tool call per skill, qualified by `loaded` when the caller has it.
 */
export function skillDirective(skills: string[], opts: { loaded?: readonly string[] } = {}): string {
  const named = [...new Set(skills.filter(Boolean).map((s) => qualifySkill(s, opts.loaded ?? [])))];
  if (!named.length) return '';
  return `\nChosen for this run, in addition to any the plan names: ${skillCallsLine(named)}\n`;
}

/**
 * The standing `ultracode` opt-in, as a session reads it.
 *
 * There is no CLI flag for this. The opt-in IS the word — the harness sees
 * `ultracode` in the prompt, confirms it back to the session with a
 * system-reminder, and the licence then stands for the rest of that session.
 * So this is not a directive the console enforces; it is a permission the
 * console grants, and it has to say what it grants or a model will read it as
 * an order and fan out over a one-line edit.
 *
 * Byte-pinned by `viewer/test/ultra-tiers.test.ts` in both directions: the line
 * as written when the opt-in is on, and its complete ABSENCE when it is off.
 * The second half is the one that matters — a workflow fans out dozens of
 * agents, and a run that never asked for that must not be paying for it.
 */
export const ULTRACODE_LINE =
  'ultracode — this session may use the Workflow tool wherever the work genuinely fans out. '
  + 'A workflow runs dozens of agents in parallel and the token cost of that is accepted for this '
  + 'run. It is a standing licence and not an instruction: a one-file edit is still a one-file edit, '
  + 'and reaching for a workflow where a single pass would do spends the budget the fan-out was '
  + 'meant for.';

/**
 * The line appended to a prompt when the run, the phase or the ticket opted in.
 *
 * One composer, every prompt family — the phase attempt (fresh boot and all
 * five briefs), and the agent ticket — for the reason `skillDirective`'s own
 * comment gives: a second copy of a sentence is a second sentence the day one
 * of them is edited.
 */
export function ultracodeDirective(on: boolean): string {
  return on ? `\n${ULTRACODE_LINE}\n` : '';
}

/**
 * The line appended to a boot prompt for MCP servers chosen in the console.
 *
 * Same shape and same reason as `skillDirective`: the engine's boot prompt
 * already names what the PLAN says a phase needs, and this is the operator
 * adding to it for one run.
 *
 * The session is told these are already connected, because by the time it reads
 * this the preflight has proved they are — and told not to work around a
 * missing one, because that is precisely the failure this whole path exists to
 * prevent. In `-p` there is no `/mcp` panel: the CLI reports an unavailable
 * server to the MODEL, and a model that treats it as a hint improvises for an
 * hour and hands back work that used none of what was chosen for it.
 */
/**
 * The credentials the plan named for this phase that the console could not
 * find before the spawn, under `credential policy: continue` (phase 11,
 * ZTD-4). Told to the session the way a degraded MCP server is: by name, with
 * the instruction to do what does not need it and record the rest as an
 * operator errand — never to improvise a credential or ask a person mid-run.
 */
export function credentialsDirective(missing: { id: string; reason: string }[]): string {
  if (!missing.length) return '';
  const named = missing.map((m) => `\`${m.id}\` (${m.reason})`).join(', ');
  return `\nThe plan names credential${missing.length === 1 ? '' : 's'} this console could not find before it started you: `
    + `${named}. The credential policy is \`continue\`, so you were boarded anyway. Do the work that does not need `
    + `${missing.length === 1 ? 'it' : 'them'}; for the rest, record an operator errand under **Outstanding** in the `
    + 'handoff naming the credential id, and if the phase genuinely cannot proceed at all declare it — '
    + `\`phase-outcome.sh <slug> <N> blocked --needs credential --reason "<id> is not held"\` — rather than asking. `
    + 'Never print a credential\'s value.\n';
}

export function mcpDirective(servers: string[], degraded: McpDegradation[] = []): string {
  const named = [...new Set(servers.filter(Boolean))];
  const attached = named.length
    ? `\nThe following MCP server${named.length === 1 ? ' is' : 's are'} attached to this session `
      + `and verified connected before it started: ${named.map((name) => `\`${name}\``).join(', ')}. `
      + `Prefer ${named.length === 1 ? 'its' : 'their'} tools over improvising the same information by hand.\n`
      + `If one turns out to be unavailable mid-phase, say so plainly in your handoff rather than working `
      + 'around it silently — an unattended session cannot sign a server in, and a phase that quietly did '
      + 'without is worse than one that stopped and said why.\n'
    : '';
  return attached + degradedDirective(degraded);
}

/**
 * The servers this phase asked for and did not get.
 *
 * Said out loud, and said HERE, because the alternative is what the CLI does on
 * its own: it drops the tools and leaves the model to notice. A model that
 * notices mid-phase either improvises a substitute — the exact failure the
 * preflight was built to stop — or treats it as a blocker and stops a phase
 * that had plenty of work it could do.
 *
 * So the instruction is deliberately two-sided. Do not invent a replacement,
 * and do not down tools either: do what can be done, and leave a named errand
 * behind. That errand is the whole reason `continue` is safe as a default — the
 * degradation ends up in a handoff a person reads, not only in a journal.
 */
function degradedDirective(degraded: McpDegradation[]): string {
  if (!degraded.length) return '';
  const named = degraded
    .map((row) => `\`${row.id}\` (${row.detail ?? mcpReasonText(row.reason)})`)
    .join(', ');
  const one = degraded.length === 1;
  return `\nThe following MCP server${one ? ' was' : 's were'} requested for this phase and ${one ? 'is' : 'are'} `
    + `**UNAVAILABLE**: ${named}. ${one ? 'It has' : 'They have'} been left out of this session — `
    + `${one ? 'its' : 'their'} tools do not exist here and cannot be signed in from an unattended run.\n`
    + 'Do two things about that, and neither of them silently: do NOT improvise a substitute for what '
    + `${one ? 'that server' : 'those servers'} would have told you, and do NOT treat ${one ? 'it' : 'them'} `
    + 'as a blocker either. Do the work that does not depend on '
    + `${one ? 'it' : 'them'}, and record what you could not do — naming the server — under **Outstanding** `
    + 'in your handoff, as an errand for the operator.\n';
}
