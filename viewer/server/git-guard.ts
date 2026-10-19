/**
 * The console's own git, out of reach of what a session can plant in a tree it
 * works in (one-pool phase 2, #272).
 *
 * A session edits a run tree for hours, and a run tree's `.git/config` is one
 * `git config` (or one Write) away: a `core.fsmonitor` command runs on the next
 * `git status`, a `core.hooksPath` script on the next merge, a credential helper
 * on the next push — and they run as the CONSOLE, on its next git call in that
 * tree, outside every wall a session's own tool calls meet. The evidence reader
 * (`permissions/walls.ts` `EVIDENCE_GIT`) and the verify export were hardened;
 * the common runner was not.
 *
 * Two halves, because a config file can say more than any override can undo.
 *
 * **Neutralised** — every git the console runs goes through `shell()` with
 * `channel: 'git'`, and the seam hands it `hardenedGitEnv`: the system config
 * off (`GIT_CONFIG_NOSYSTEM`), and command-scope keys (`GIT_CONFIG_COUNT`),
 * which git reads LAST, so they win over the repository's, an included file's
 * and the user's alike — `core.hooksPath` (no hook runs), `core.fsmonitor`,
 * `core.pager`, `core.askPass`, `core.editor`, `sequence.editor`,
 * `protocol.ext.allow`, and `credential.helper` reset to the operator's own
 * helpers from their GLOBAL config (an empty value clears the list, the
 * URL-scoped helpers included). `core.sshCommand` is outranked by
 * `GIT_SSH_COMMAND`, set to the operator's own (the environment's, else the
 * global config's, else `ssh`). An `alias.*` never shadows a built-in, and the
 * console runs nothing else.
 *
 * **Detected** — what no override can undo: a diff, merge or filter driver, a
 * URL rewrite, an `include.path` and the rest of `GUARDED_KEYS`. The runner
 * reads a lane's trees' local config before its session spawns and again when
 * it exits (`readTreeConfig`), and a guarded key that is new — planted — parks
 * the lane `run-tree-config`, naming the key, before any verification or
 * landing git runs there (`runner-attempt.ts`).
 *
 * The files are READ, never handed to `git config`: that verb is not one the
 * console may run (`never-push.test.ts`), and a reader that spawns nothing
 * cannot be steered by what it reads.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/**
 * The keys a session must never get the console to run, as git writes them
 * lower-cased (`section[.subsection].name`). Anything matching is reported when
 * it appears in a run tree's local config; the first block is ALSO neutralised
 * on every console git call (`OVERRIDES`).
 */
export const GUARDED_KEYS: readonly RegExp[] = Object.freeze([
  /^core\.(?:hookspath|fsmonitor|sshcommand|askpass|pager|editor|gitproxy|alternaterefscommand)$/,
  /^sequence\.editor$/,
  /^pager\..+$/,
  /^(?:commit|tag)\.gpgsign$/,
  /^gpg\.ssh\.defaultkeycommand$/,
  /^submodule\..+\.update$/,
  /^hook\..+\.(?:command|event)$/,
  /^(?:interactive\.difffilter|(?:difftool|mergetool)\..+\.cmd|trailer\..+\.(?:command|cmd))$/,
  /^credential\.(?:.+\.)?helper$/,
  /^alias\..+$/,
  /^include\.path$/,
  /^includeif\..+\.path$/,
  /^diff\.(?:external|.+\.command|.+\.textconv)$/,
  /^merge\..+\.driver$/,
  /^filter\..+\.(?:clean|smudge|process)$/,
  /^gpg\.(?:.+\.)?program$/,
  /^protocol\.(?:.+\.)?allow$/,
  /^remote\..+\.(?:uploadpack|receivepack|vcs)$/,
  /^url\..+\.(?:insteadof|pushinsteadof)$/,
]);

/** Is this config key one a planted value could turn into a command the console runs? */
export function guardedKey(key: string): boolean {
  const lower = key.toLowerCase();
  return GUARDED_KEYS.some((pattern) => pattern.test(lower));
}

/** The command-scope values every console git call carries, in order. */
const OVERRIDES: readonly (readonly [string, string])[] = Object.freeze([
  Object.freeze(['core.hooksPath', '/dev/null'] as const),
  Object.freeze(['core.fsmonitor', 'false'] as const),
  Object.freeze(['core.pager', 'cat'] as const),
  Object.freeze(['core.askPass', ''] as const),
  Object.freeze(['core.editor', ':'] as const),
  Object.freeze(['sequence.editor', ':'] as const),
  Object.freeze(['protocol.ext.allow', 'never'] as const),
  // No signing program runs for a commit or tag the console makes itself.
  Object.freeze(['commit.gpgSign', 'false'] as const),
  Object.freeze(['tag.gpgSign', 'false'] as const),
]);

/** The keys `hardenedGitEnv` neutralises, for a reader that must say which. */
export const NEUTRALISED_KEYS: readonly string[] = Object.freeze([
  ...OVERRIDES.map(([key]) => key), 'credential.helper', 'core.sshCommand', 'GIT_CONFIG_NOSYSTEM',
]);

/* ------------------------------------------------------------------ *
 * Reading a config file — the subset git writes, read leniently
 * ------------------------------------------------------------------ */

/** One `key = value` a config file holds, its key lower-cased as git reports it. */
export type ConfigEntry = { key: string; value: string; file: string };

/** How deep `include.path` is followed — git's own limit is 10. */
const MAX_INCLUDE_DEPTH = 10;

/**
 * Does this line continue onto the next — a backslash as its last character,
 * itself unescaped, and outside any comment (an unquoted `#` or `;`)?
 */
function continues(line: string): boolean {
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]!;
    if (char === '\\') {
      if (i === line.length - 1) return true;
      i += 1;
      continue;
    }
    if (char === '"') quoted = !quoted;
    else if (!quoted && (char === '#' || char === ';')) return false;
  }
  return false;
}

/** A value with its quotes and escapes resolved, comments stripped. */
function valueOf(raw: string): string {
  let out = '';
  let quoted = false;
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i]!;
    if (char === '"') { quoted = !quoted; continue; }
    if (char === '\\' && i + 1 < raw.length) {
      const next = raw[i + 1]!;
      out += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'b' ? '' : next;
      i += 1;
      continue;
    }
    if (!quoted && (char === '#' || char === ';')) break;
    out += char;
  }
  return out.trim();
}

/**
 * Every entry of one config file and of what it includes, or `[]` for a file
 * that is not there. `follow` decides which include keys are followed: all of
 * them for a run tree (a conditional include is followed whatever its
 * condition — detection may over-read, never under-read), `include.path` alone
 * for the operator's own global file.
 */
export function readConfigFile(file: string, follow: 'all' | 'plain' = 'all', depth = 0): ConfigEntry[] {
  let text: string;
  try {
    if (!statSync(file).isFile()) return [];
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: ConfigEntry[] = [];
  let section = '';
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    let line = lines[i]!.trim();
    // A comment ends at its newline, whatever it ends with — never joined.
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    // A continued value: a backslash that ends the line OUTSIDE a comment joins
    // the next line — read as git reads it, or a key hidden after a comment's
    // trailing backslash would be a key this reader never saw.
    while (continues(line) && i + 1 < lines.length) {
      line = line.slice(0, -1) + lines[(i += 1)]!;
    }
    const header = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\](.*)$/.exec(line);
    if (header) {
      const name = header[1]!.toLowerCase();
      section = header[2] !== undefined ? `${name}.${header[2].replace(/\\(.)/g, '$1')}` : name;
      line = header[3]!.trim();
      if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    }
    const pair = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*(.*))?$/.exec(line);
    if (!pair || !section) continue;
    const key = `${section}.${pair[1]!.toLowerCase()}`;
    const value = pair[2] === undefined ? 'true' : valueOf(pair[2]);
    out.push({ key, value, file });
    const include = key === 'include.path' || (follow === 'all' && /^includeif\..+\.path$/.test(key));
    if (include && value && depth < MAX_INCLUDE_DEPTH) {
      const target = value.startsWith('~/') ? join(homedir(), value.slice(2)) : isAbsolute(value) ? value : resolve(dirname(file), value);
      out.push(...readConfigFile(target, follow, depth + 1));
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * A tree's own config
 * ------------------------------------------------------------------ */

/** A repository's config file, and a linked worktree's own (`extensions.worktreeConfig`). */
const CONFIG_FILE = 'config';
const WORKTREE_CONFIG_FILE = 'config.worktree';

/** The git directory and the common directory of a working tree, or null when it is not one. */
export function gitDirsOf(tree: string): { gitDir: string; commonDir: string } | null {
  const dotGit = join(tree, '.git');
  let gitDir: string;
  try {
    const stat = statSync(dotGit);
    if (stat.isDirectory()) gitDir = dotGit;
    else {
      const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'));
      if (!pointer) return null;
      gitDir = resolve(tree, pointer[1]!.trim());
    }
  } catch {
    return null;
  }
  let commonDir = gitDir;
  try {
    const common = readFileSync(join(gitDir, 'commondir'), 'utf8').trim();
    if (common) commonDir = resolve(gitDir, common);
  } catch { /* a main worktree has none */ }
  return { gitDir, commonDir };
}

/**
 * The guarded entries a working tree's LOCAL config holds — the repository's
 * `config`, the worktree's `config.worktree`, and what they include — each as
 * `key=value`. The operator's global and system files are not read: a session
 * reaching those is outside a run tree, and the console's own git never reads
 * the system file at all.
 */
export function readTreeConfig(tree: string): string[] {
  const dirs = gitDirsOf(tree);
  if (!dirs) return [];
  // The repository's file, then the worktree's own — built one by one, not as a
  // literal list: `never-push.test.ts` reads a list of words as an argv.
  const files = new Set<string>();
  files.add(join(dirs.commonDir, CONFIG_FILE));
  files.add(join(dirs.commonDir, WORKTREE_CONFIG_FILE));
  files.add(join(dirs.gitDir, WORKTREE_CONFIG_FILE));
  const out = new Set<string>();
  for (const file of files) {
    for (const entry of readConfigFile(file, 'all')) {
      if (guardedKey(entry.key)) out.add(`${entry.key}=${entry.value}`);
    }
  }
  return [...out].sort();
}

/**
 * The working trees a lane's session can reach: its root, and each repository
 * its scope names under it — every submodule `.gitmodules` lists when the
 * scope is `all` or unstated. A path that leaves the root is not one.
 */
export function configTreesOf(root: string, scope: readonly string[]): string[] {
  const all = !scope.length || scope.includes('all');
  const paths = all
    ? readConfigFile(join(root, '.gitmodules'), 'plain').filter((e) => /^submodule\..+\.path$/.test(e.key)).map((e) => e.value)
    : scope;
  const out = [root];
  for (const rel of paths) {
    if (!rel || isAbsolute(rel) || rel.split('/').includes('..')) continue;
    out.push(join(root, rel));
  }
  return [...new Set(out)];
}

/** What a set of trees' guarded config reads as, per tree. */
export type TreeConfigBaseline = Map<string, string[]>;

/** Read every tree that is a git working tree. */
export function treeConfigBaseline(trees: readonly string[]): TreeConfigBaseline {
  const out: TreeConfigBaseline = new Map();
  for (const tree of new Set(trees)) {
    if (existsSync(join(tree, '.git'))) out.set(tree, readTreeConfig(tree));
  }
  return out;
}

/** One guarded entry a tree holds now that it did not hold at the baseline. */
export type PlantedConfig = { tree: string; entry: string; key: string };

/**
 * The guarded entries that APPEARED (or changed value) in each tree since the
 * baseline was read — what a session planted. Empty when nothing did.
 */
export function plantedSince(baseline: TreeConfigBaseline): PlantedConfig[] {
  const out: PlantedConfig[] = [];
  for (const [tree, before] of baseline) {
    const had = new Set(before);
    for (const entry of readTreeConfig(tree)) {
      if (!had.has(entry)) out.push({ tree, entry, key: entry.slice(0, entry.indexOf('=')) });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * The environment every console git call runs in
 * ------------------------------------------------------------------ */

/** The operator's GLOBAL config files, in the order git reads them. */
function globalConfigFiles(env: NodeJS.ProcessEnv): string[] {
  if (env.GIT_CONFIG_GLOBAL) return [env.GIT_CONFIG_GLOBAL];
  const xdg = env.XDG_CONFIG_HOME ? join(env.XDG_CONFIG_HOME, 'git', 'config') : join(homedir(), '.config', 'git', 'config');
  return [xdg, join(homedir(), '.gitconfig')];
}

/** What the operator's own global config says, for the keys the overrides must restore. */
function trustedOf(env: NodeJS.ProcessEnv): { helpers: [string, string][]; sshCommand: string | null } {
  const entries = globalConfigFiles(env).flatMap((file) => readConfigFile(file, 'plain'));
  const helpers: [string, string][] = [];
  let sshCommand: string | null = null;
  for (const entry of entries) {
    if (/^credential\.(?:.+\.)?helper$/.test(entry.key)) {
      // The subsection (a URL) keeps its case; the reader lower-cased the section and name only.
      helpers.push([entry.key, entry.value]);
    } else if (entry.key === 'core.sshcommand') sshCommand = entry.value;
  }
  return { helpers, sshCommand };
}

/**
 * `env` with the console's git hardening applied: the system config off, the
 * command-scope keys appended after any the caller already set, the credential
 * helpers reset to the operator's global ones, and `GIT_SSH_COMMAND` pinned.
 */
export function hardenedGitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env, GIT_CONFIG_NOSYSTEM: '1' };
  const trusted = trustedOf(env);
  const pairs: [string, string][] = [
    ...OVERRIDES.map(([key, value]) => [key, value] as [string, string]),
    ['credential.helper', ''],
    ...trusted.helpers,
  ];
  const start = Number.parseInt(env.GIT_CONFIG_COUNT ?? '0', 10);
  let n = Number.isInteger(start) && start > 0 ? start : 0;
  for (const [key, value] of pairs) {
    out[`GIT_CONFIG_KEY_${n}`] = key;
    out[`GIT_CONFIG_VALUE_${n}`] = value;
    n += 1;
  }
  out.GIT_CONFIG_COUNT = String(n);
  out.GIT_SSH_COMMAND = env.GIT_SSH_COMMAND || trusted.sshCommand || 'ssh';
  return out;
}
