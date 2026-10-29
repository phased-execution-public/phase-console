/**
 * The plugin tree this console hands its sessions (measured-console phase 10,
 * the audit's A11): `<instance state>/plugin/<rev>/`, materialized from the
 * console's own revision by `scripts/build-plugin-tree.mjs` — the skill, its
 * scripts and its `hooks/hooks.json`, and nothing of the console — so a session
 * loads the skill of the console that launched it (`--plugin-dir`, phase 11)
 * rather than whatever commit a config dir's marketplace install sits at.
 *
 * Built at boot (a restart is how `update` lands, so boot covers it), in a
 * child process so the event loop never waits on git; idempotent — a tree
 * whose stamp names this revision is left alone; old revisions are pruned to
 * `PLUGIN_TREE_KEEP`, and only a directory the builder marked as its own is
 * ever removed. Fail-open: a console whose tree did not build still runs, and
 * `pluginDirFor` answers null.
 */

import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { log } from './log.ts';

/** How many revisions' trees stay on disk: this one and the one before it (a session still running from it). */
export const PLUGIN_TREE_KEEP = 2;
const MARKER = '.plugin-tree';
const STAMP = 'plugin-stamp.json';
/**
 * This copy's own builder — it reads any root it is handed. Derived from the module's
 * URL, the one form the Pro package's bundle relocates.
 */
const BUILDER = fileURLToPath(new URL('../../scripts/build-plugin-tree.mjs', import.meta.url));

export type PluginTreeResult = {
  /** The tree's directory. */
  dir: string;
  /** The revision it was built from; null for a checkout git cannot read (a package), built from its files. */
  rev: string | null;
  /** False when a tree of this revision was already on disk. */
  built: boolean;
  /** Older trees removed. */
  pruned: string[];
  bytes?: number;
  files?: number;
};

/** The tree this console's boot built or found — what its sessions are handed (phase 11). */
let current: string | null = null;

/** The tree `ensurePluginTree` last answered for, when it is still whole on disk; null otherwise. */
export function currentPluginDir(): string | null {
  return current && existsSync(join(current, MARKER)) ? current : null;
}

/** Where the trees live under one instance's state directory. */
export function pluginTreesDir(stateDir: string): string {
  return join(stateDir, 'plugin');
}

function run(file: string, args: string[], cwd?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { cwd, maxBuffer: 16 * 1024 * 1024, timeout: 120_000 }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? (error as unknown as { code: number }).code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** The revision a console checkout stands on; null when git cannot say (a package install). */
export async function consoleRevision(root: string): Promise<string | null> {
  const out = await run('git', ['-C', root, 'rev-parse', '--verify', 'HEAD^{commit}']);
  const rev = out.stdout.trim();
  return out.code === 0 && /^[0-9a-f]{40}$/.test(rev) ? rev : null;
}

function readStamp(dir: string): { rev?: string | null; bytes?: number; files?: number } | null {
  try { return JSON.parse(readFileSync(join(dir, STAMP), 'utf8')); } catch { return null; }
}

/** The directory name a revision's tree takes: the full sha, or `worktree-<version>` for a checkout git cannot read. */
function keyFor(rev: string | null, root: string): string {
  if (rev) return rev;
  let version = 'unknown';
  try { version = String(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version ?? version); } catch { /* unknown */ }
  return `worktree-${version.replace(/[^\w.-]/g, '_')}`;
}

/** The tree built for `rev`, when one is on disk and whole; null otherwise. */
export function pluginDirFor(rev: string | null, stateDir: string, root = ''): string | null {
  const dir = join(pluginTreesDir(stateDir), keyFor(rev, root));
  return existsSync(join(dir, MARKER)) && readStamp(dir) ? dir : null;
}

/** Remove every marked tree but `current` and the newest others, to `keep` in all. */
export function prunePluginTrees(stateDir: string, current: string, keep = PLUGIN_TREE_KEEP): string[] {
  const base = pluginTreesDir(stateDir);
  let names: string[];
  try { names = readdirSync(base); } catch { return []; }
  const trees = names
    .filter((name) => name !== current && !name.includes('.tmp-') && existsSync(join(base, name, MARKER)))
    .map((name) => ({ name, at: statSync(join(base, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  const pruned: string[] = [];
  for (const { name } of trees.slice(Math.max(0, keep - 1))) {
    try { rmSync(join(base, name), { recursive: true, force: true }); pruned.push(name); } catch { /* the next boot tries again */ }
  }
  return pruned;
}

/**
 * Make sure this console's revision has its tree, and prune the old ones.
 * Never throws: a failure is logged and answers null.
 */
export async function ensurePluginTree(input: {
  root: string;
  stateDir: string;
  node?: string;
  rev?: string | null;
  keep?: number;
}): Promise<PluginTreeResult | null> {
  const { root, stateDir } = input;
  try {
    const rev = input.rev !== undefined ? input.rev : await consoleRevision(root);
    const key = keyFor(rev, root);
    const dir = join(pluginTreesDir(stateDir), key);
    const existing = pluginDirFor(rev, stateDir, root);
    let built = false;
    let stamp = existing ? readStamp(existing) : null;
    if (!existing || (rev && stamp?.rev !== rev)) {
      const args = [BUILDER, '--root', root, '--out', dir, '--json', ...(rev ? ['--rev', rev] : ['--worktree'])];
      const out = await run(input.node ?? process.execPath, args);
      if (out.code !== 0) {
        log.warn('plugin.tree-failed', { rev, dir, code: out.code, error: out.stderr.trim().slice(0, 500) });
        return null;
      }
      built = true;
      stamp = readStamp(dir);
    }
    const pruned = prunePluginTrees(stateDir, key, input.keep ?? PLUGIN_TREE_KEEP);
    const result: PluginTreeResult = {
      dir, rev, built, pruned,
      ...(typeof stamp?.bytes === 'number' ? { bytes: stamp.bytes } : {}),
      ...(typeof stamp?.files === 'number' ? { files: stamp.files } : {}),
    };
    if (built || pruned.length) log.info('plugin.tree-built', { ...result });
    current = dir;
    return result;
  } catch (error) {
    log.warn('plugin.tree-failed', { error: String((error as Error)?.message ?? error) });
    return null;
  }
}
