/**
 * The estate: every repository this console stands on, and where its issues live.
 *
 * A Phase Console instance is rarely one repository. It is a docs root that
 * holds plans and a set of submodules the phases actually edit, and an operator
 * asking "what is open against my work" means all of them. This module is the
 * list — the root first, then every initialised submodule — with the GitHub
 * remote each one publishes to, when it has one.
 *
 * ## Three rules it does not bend
 *
 * **A repository with no GitHub remote is LISTED, never dropped.** It is a real
 * repository the operator works in; answering as if it did not exist is the
 * failure mode this whole surface was written against. It arrives with
 * `issues: 'unknown'` and `reason: 'no-remote'`, which is a different sentence
 * from "no issues" and renders as one.
 *
 * **The remote is read off DISK, not out of git.** `git remote get-url` would
 * be the obvious call and it is unavailable here for a reason worth naming:
 * `remote` is on `never-push.test.ts`'s banned verb list, because the argv scan
 * cannot tell `remote get-url` from `remote add`. `git config --get` would need
 * `config` added to the console-wide git allow-list, which would license every
 * server file to WRITE config. So the URL comes from the config file itself —
 * `.git/config` for a normal checkout, and the `gitdir:` a submodule's `.git`
 * file points at for a submodule. No process, no verb, provably read-only.
 *
 * **The inventory's names ARE the plan's scope tokens.** A submodule is keyed
 * by its root-relative path, which is what `repoTargets()` keys it by and what
 * a plan's Repos column spells; the token is that path through
 * `shared/scope.js`'s own `normalizeToken`, so the two readings cannot drift.
 * A plan authored from these issues therefore names repositories the lock
 * engine already understands.
 *
 * Enumeration itself is `git-browse.ts`'s `submoduleDirs` rather than a second
 * `.gitmodules` walk: it is already recursive, depth-capped, `safePath`-checked
 * and initialised-only, and two walks that disagree about what a repository is
 * would be two allowlists.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';

import { submoduleDirs } from '../git-browse.ts';
import { normalizeToken } from '../../shared/scope.js';

/** A GitHub remote, split once so nothing downstream re-parses a URL. */
export type GitHubRemote = {
  owner: string;
  repo: string;
  /** `owner/repo` — what `gh --repo` takes and what an issue ref names. */
  nameWithOwner: string;
};

/** Why a repository's issues cannot be known. The estate's honest fourth state. */
export type InventoryReason = 'no-remote';

export type InventoryRepo = {
  /** The stable handle: `root`, or the root-relative path — `repoTargets`' key. */
  key: string;
  /** What to show a person. */
  label: string;
  /** The plan Repos-column token for this repository. */
  scopeToken: string;
  /** Absolute directory. Produced here, never received. */
  dir: string;
  kind: 'root' | 'submodule';
  /** The configured `origin`, verbatim, when there is one. */
  remote?: string;
  /** Set only when `remote` is a GitHub one. */
  github?: GitHubRemote;
  /** `no-remote` when this repository publishes nowhere issues can be read from. */
  reason?: InventoryReason;
};

/** How many repositories one estate may hold. A root with more has other problems. */
export const INVENTORY_CAP = 64;

/**
 * The `origin` URL configured for a checkout, or `null`.
 *
 * Handles both shapes of `.git`: a directory (a normal checkout) and the file a
 * submodule has, whose `gitdir:` line points into the superproject's
 * `.git/modules/…`. A relative `gitdir:` is resolved against the checkout, which
 * is how git itself reads it.
 */
export function readOriginUrl(dir: string): string | null {
  const config = configPathFor(dir);
  if (!config) return null;
  let text: string;
  try { text = readFileSync(config, 'utf8'); } catch { return null; }
  return parseOriginUrl(text);
}

/** Where a checkout's config file is — through a submodule's `gitdir:` when needed. */
function configPathFor(dir: string): string | null {
  const dotGit = join(dir, '.git');
  let stat;
  try { stat = statSync(dotGit); } catch { return null; }
  if (stat.isDirectory()) return join(dotGit, 'config');
  if (!stat.isFile()) return null;
  let pointer: string;
  try { pointer = readFileSync(dotGit, 'utf8'); } catch { return null; }
  const match = /^\s*gitdir:\s*(.+?)\s*$/m.exec(pointer);
  if (!match) return null;
  const target = match[1];
  const gitDir = isAbsolute(target) ? target : resolve(dir, target);
  const config = join(gitDir, 'config');
  return existsSync(config) ? config : null;
}

/**
 * `url = …` under `[remote "origin"]` in a git config file.
 *
 * Written as a small state machine over sections rather than one regex: a
 * config may hold several remotes, `[remote "upstream"]` may come first, and a
 * regex that found the first `url =` in the file would answer with somebody
 * else's fork. Subsection matching is case-sensitive, as git's is.
 */
export function parseOriginUrl(text: string): string | null {
  let inOrigin = false;
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    if (line.startsWith('[')) {
      inOrigin = /^\[remote\s+"origin"\]$/.test(line);
      continue;
    }
    if (!inOrigin) continue;
    const match = /^url\s*=\s*(.+)$/.exec(line);
    if (match) {
      const url = match[1].trim();
      if (url) return url;
    }
  }
  return null;
}

/**
 * A GitHub remote's `owner/repo`, or `null` for anything else.
 *
 * Four spellings reach here in practice — `git@github.com:O/R.git`,
 * `https://github.com/O/R.git`, `ssh://git@github.com/O/R` and the same with a
 * trailing slash — and one that must NOT: a remote on another host. A
 * self-hosted or GitLab remote is a real remote and a repository we
 * nevertheless cannot ask `gh` about, so it answers `null` and its repository is
 * listed `unknown (no-remote)` — "no GitHub remote" is precisely what that
 * reason means.
 *
 * The owner and repo shapes are pinned to GitHub's own alphabet, which is also
 * what makes this the injection gate: everything downstream passes
 * `nameWithOwner` to `gh --repo` in a fixed argv, and a name that could carry a
 * flag, a path traversal or a shell character never becomes one here.
 */
export function parseGitHubRemote(url: string | null | undefined): GitHubRemote | null {
  const raw = String(url ?? '').trim();
  if (!raw || raw.length > 512) return null;
  const scp = /^(?:[\w.-]+@)?github\.com:(.+)$/.exec(raw);
  const uri = /^(?:https?|ssh|git):\/\/(?:[^@/]*@)?github\.com(?::\d+)?\/(.+)$/.exec(raw);
  const path = scp?.[1] ?? uri?.[1];
  if (!path) return null;
  const parts = path.replace(/\.git$/, '').replace(/\/+$/, '').split('/');
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner)) return null;
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(repo) || repo === '.' || repo === '..') return null;
  return { owner, repo, nameWithOwner: `${owner}/${repo}` };
}

/**
 * Every repository under `root`, root first.
 *
 * Pure: it reads `.gitmodules` and config files and runs nothing. A repository
 * whose remote cannot be read is not an error — it is a row.
 */
export function repoInventory(root: string): InventoryRepo[] {
  const out: InventoryRepo[] = [];
  const add = (key: string, label: string, dir: string, kind: InventoryRepo['kind']) => {
    if (out.length >= INVENTORY_CAP) return;
    const remote = readOriginUrl(dir);
    const github = parseGitHubRemote(remote);
    out.push({
      key,
      label,
      // The root's token is its directory NAME, not the word `root`: a plan's
      // Repos cell names repositories the way a person writes them, and
      // `pe-hub` is what they write. Submodules take their root-relative path,
      // which is already the scope token `repoTargets` keys them by.
      scopeToken: normalizeToken(kind === 'root' ? basename(dir) : key) || key,
      dir,
      kind,
      ...(remote ? { remote } : {}),
      ...(github ? { github } : { reason: 'no-remote' as const }),
    });
  };

  add('root', basename(root) || 'repository root', root, 'root');
  for (const sub of submoduleDirs(root)) add(sub.rel, sub.rel, sub.dir, 'submodule');
  return out;
}

/** The repositories `gh` can actually be asked about, in inventory order. */
export function askableRepos(inventory: readonly InventoryRepo[]): InventoryRepo[] {
  return inventory.filter((repo) => repo.github);
}

/** Find a repository by `owner/repo`. The inventory is the allowlist, as always. */
export function repoByNameWithOwner(
  inventory: readonly InventoryRepo[], nameWithOwner: string,
): InventoryRepo | null {
  return inventory.find((repo) => repo.github?.nameWithOwner === nameWithOwner) ?? null;
}
