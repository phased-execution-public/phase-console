/**
 * What a SHARED checkout is standing on, and whose branch that is
 * (control-tower phase 40, #41).
 *
 * A phase lock says who may WRITE a repository for the length of one phase. It
 * says nothing about which branch the tree is left on — and a new-branch run
 * in the shared checkout leaves its scoped repositories on `pe/<slug>` for as
 * long as the RUN lives, across every phase and every lock it takes. A sibling
 * run admitted between two of those phases then verified against the other
 * run's in-flight branch: three measured false reds on 2026-09-21, and the
 * same shape could just as well have produced a false green.
 *
 * This module is the ONE reader of that fact:
 *
 * - `readTrees(root, scope)` — every repository under a scope (a
 *   superproject's initialized submodules included, through the same
 *   `resolveMounts` the mirror uses) with its branch and head.
 * - The HOLD records: a run that checked a shared repository onto its own
 *   branch writes one file per repository under `<state>/trees/`, and removes
 *   it when the run settles. One file per (run, repository), `key=value`
 *   lines, so `scripts/phase-lock.sh conflicts` reads the very same records
 *   the scheduler does — a hand-driven session and the autopilot get one
 *   answer.
 * - `branchHolderOf` — the pure rule: a repository in this scope stands on a
 *   branch another open run holds, and this claim is not carved away from it
 *   (`claimsDisjoint` with a hold on one side). `branchHoldNow` asks it over
 *   facts read with no git process (HEAD off disk, the scope by path), which
 *   is what an admission scan may afford: synchronous, and nothing to read
 *   unless a hold's repository is in reach.
 *
 * Git is read through `worktree.ts`'s exported readers, never a runner of its
 * own (`never-push.test.ts`); the one write — returning a tree to the branch
 * it was found on — is `worktree.ts`'s `returnTree`.
 */

import { createHash } from 'node:crypto';
import {
  closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { STATE_DIR } from '../config.ts';
import { claimsDisjoint, normalizeToken } from '../../shared/scope.js';
import { baseBranch, commitOf, realish, resolveMounts } from './worktree.ts';

/** One repository under a scope, as it stands right now. */
export type TreeRepo = {
  /** Root-relative path, `''` for the root itself. */
  rel: string;
  /** Physical path of the repository's top. */
  dir: string;
  /** The branch it stands on; absent on a detached HEAD or an unreadable one. */
  branch?: string;
  /** Its HEAD commit; absent when it cannot be read. */
  head?: string;
};

/** A run's hold on one shared repository — the record under `<state>/trees/`. */
export type TreeHold = {
  run: string;
  slug: string;
  /** `autopilot/<runId>` — what a session of that run carries as `$PE_OWNER`. */
  owner: string;
  /** Physical path of the held repository. */
  repo: string;
  /** Its path relative to the run's root, `''` for the root. */
  rel: string;
  /** The run's root — the shared checkout. */
  root: string;
  /** The branch the run put there (`pe/<slug>`). */
  branch: string;
  /** The branch the repository stood on before the run touched it, when it was seen. */
  foundOn?: string;
  at: string;
  /** The run's state file: a hold whose run has settled lapses without its release. */
  runFile?: string;
  /** The hold file itself — set by `readHolds`. */
  file?: string;
};

/** What the scheduler's `branch` holder and the queue page say. */
export type BranchHoldView = {
  /** The repository, root-relative (`.` for the root). */
  repo: string;
  /** Its physical path. */
  dir: string;
  branch: string;
  /** The holding run's id and plan. */
  run: string;
  slug: string;
  head?: string;
};

/** Where one verification's repository stood — `{repo, branch, head}` and why it is listed. */
export type TreeStamp = {
  repo: string;
  /** `null` on a detached HEAD, or when it could not be read. */
  branch: string | null;
  head: string | null;
  /**
   * `verify-in` — the repository the commands ran in; `scope` — one the phase's
   * Repos cell names; `named` — one a command reached with `cd` or `git -C`;
   * `sibling` — any other repository under the run's root, which a command can
   * read through a path no parser sees (the measured case read `../aws`).
   */
  role: 'verify-in' | 'scope' | 'named' | 'sibling';
};

/**
 * How often a phase queued in a SHARED checkout re-reads the trees it is
 * waiting on. A holder settling is seen at the scheduler's next scan (its hold
 * record is gone, or its run file says so); a tree moved back by hand is only
 * seen by reading git again, and this is how often that happens.
 */
export const TREE_POLL_MS = 20_000;

/** How many repositories one verification stamp lists at most. */
export const STAMP_CAP = 24;

/* ------------------------------------------------------------------ *
 * Reading the trees
 * ------------------------------------------------------------------ */

/**
 * Every repository a scope reaches under `root`, root first, then by depth.
 * Each token resolves on its own, so one token naming nothing on disk costs
 * that token and not the rest of the scope.
 */
export async function reposUnder(root: string, scope: readonly string[]): Promise<{ rel: string; dir: string }[]> {
  const byDir = new Map<string, { rel: string; dir: string }>();
  for (const token of scope.length ? scope : ['all']) {
    let resolved;
    try {
      resolved = await resolveMounts(root, [token]);
    } catch {
      continue;
    }
    if (!resolved.ok) continue;
    for (const mount of resolved.mounts) {
      const dir = realish(mount.source);
      if (!byDir.has(dir)) byDir.set(dir, { rel: mount.rel, dir });
    }
  }
  return [...byDir.values()].sort((a, b) => depth(a.rel) - depth(b.rel) || a.rel.localeCompare(b.rel));
}

function depth(rel: string): number {
  return rel ? rel.split(sep).length : 0;
}

/** Every repository a scope reaches, with its branch and head. */
export async function readTrees(root: string, scope: readonly string[]): Promise<TreeRepo[]> {
  const repos = await reposUnder(root, scope);
  return Promise.all(repos.map(async ({ rel, dir }) => {
    const [branch, head] = await Promise.all([baseBranch(dir), commitOf(dir, 'HEAD')]);
    return { rel, dir, ...(branch ? { branch } : {}), ...(head ? { head } : {}) };
  }));
}

/** Is `branch` this plan's own — the run branch or one of its lanes? */
export function ownBranch(branch: string | undefined, slug: string): boolean {
  if (!branch) return false;
  if (branch === `pe/${slug}`) return true;
  return new RegExp(`^pe/${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-p\\d+$`).test(branch);
}

/** The plan a `pe/` branch names, or undefined for any other branch. */
export function planOfBranch(branch: string | undefined): string | undefined {
  const m = /^pe\/(.+?)(?:-p\d+)?$/.exec(branch ?? '');
  return m?.[1];
}

/* ------------------------------------------------------------------ *
 * The hold records
 * ------------------------------------------------------------------ */

/** Where hold records live: the machine's state home, shared by every console on it. */
export function treesDir(): string {
  return join(STATE_DIR, 'trees');
}

function holdFile(run: string, repo: string): string {
  const key = createHash('sha256').update(realish(repo)).digest('hex').slice(0, 8);
  return join(treesDir(), `${run.replace(/[^A-Za-z0-9._-]/g, '_')}-${key}.hold`);
}

/**
 * A hold's fields and their names on disk, in write order. An OBJECT, not an
 * array of pairs: `never-push.test.ts` reads every all-string array literal
 * under `server/` as a git argv.
 */
const HOLD_NAMES: Partial<Record<keyof TreeHold, string>> = {
  run: 'run', slug: 'slug', owner: 'owner', repo: 'repo', rel: 'rel', root: 'root',
  branch: 'branch', foundOn: 'found_on', at: 'at', runFile: 'run_file',
};
const HOLD_FIELDS = Object.entries(HOLD_NAMES) as [keyof TreeHold, string][];

const oneLine = (value: string): string => value.replace(/[\r\n]+/g, ' ').trim();

/** Write (or rewrite) a hold record — atomically, so a reader never sees half of one. */
export function writeHold(hold: TreeHold): string {
  const file = holdFile(hold.run, hold.repo);
  mkdirSync(treesDir(), { recursive: true });
  const body = HOLD_FIELDS
    .filter(([key]) => hold[key] !== undefined && hold[key] !== '')
    .map(([key, name]) => `${name}=${oneLine(String(hold[key]))}`)
    .join('\n');
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${body}\n`, 'utf8');
  renameSync(tmp, file);
  return file;
}

/** Remove a run's hold on one repository. Idempotent. */
export function removeHold(run: string, repo: string): void {
  rmSync(holdFile(run, repo), { force: true });
}

function parseHold(text: string, file: string): TreeHold | null {
  const fields = new Map<string, string>();
  for (const line of text.split('\n')) {
    const at = line.indexOf('=');
    if (at > 0 && !fields.has(line.slice(0, at))) fields.set(line.slice(0, at), line.slice(at + 1));
  }
  const hold: Partial<TreeHold> = { file };
  for (const [key, name] of HOLD_FIELDS) {
    const value = fields.get(name);
    if (value !== undefined && value !== '') (hold as Record<string, string>)[key] = value;
  }
  if (!hold.run || !hold.repo || !hold.branch) return null;
  return { rel: '', slug: '', owner: `autopilot/${hold.run}`, root: '', at: '', ...hold } as TreeHold;
}

/**
 * Has the run behind this hold SETTLED? A hold is released when its run
 * settles; this is the same answer for a release that never happened (a
 * console that died, a stop of a run no loop was driving). The run file's
 * top-level `status` — written first-level, two spaces in, which is also how
 * the bash twin reads it — says `finished`, or `interrupted` by an operator's
 * stop. Any other word (parked, halted, paused, a console that died under it)
 * is a run that has not settled and still owns what it checked out.
 */
export function holdLapsed(hold: Pick<TreeHold, 'runFile'>): boolean {
  if (!hold.runFile) return false;
  if (!existsSync(hold.runFile)) return true;
  let text = '';
  try {
    // The status sits near the top of a run file; the whole file is read only
    // when it does not, or when the answer turns on `stoppedBy` further down.
    const fd = openSync(hold.runFile, 'r');
    try {
      const buf = Buffer.alloc(16 * 1024);
      text = buf.subarray(0, readSync(fd, buf, 0, buf.length, 0)).toString('utf8');
    } finally {
      closeSync(fd);
    }
    let status = STATUS_LINE.exec(text)?.[1];
    if (!status || status === 'interrupted') {
      text = readFileSync(hold.runFile, 'utf8');
      status = STATUS_LINE.exec(text)?.[1];
    }
    if (status === 'finished') return true;
    return status === 'interrupted' && /^ {2}"stoppedBy": "operator"/m.test(text);
  } catch {
    return false;
  }
}

const STATUS_LINE = /^ {2}"status": "([a-z-]+)"/m;

/** Every standing hold on this machine. A lapsed one is swept as it is read. */
export function readHolds(): TreeHold[] {
  let names: string[];
  try {
    names = readdirSync(treesDir()).filter((name) => name.endsWith('.hold'));
  } catch {
    return [];
  }
  const out: TreeHold[] = [];
  for (const name of names.sort()) {
    const file = join(treesDir(), name);
    let hold: TreeHold | null = null;
    try {
      hold = parseHold(readFileSync(file, 'utf8'), file);
    } catch {
      continue;
    }
    if (!hold) continue;
    if (holdLapsed(hold)) {
      rmSync(file, { force: true });
      continue;
    }
    out.push(hold);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * The rule
 * ------------------------------------------------------------------ */

/**
 * Which repository of this scope stands on a branch ANOTHER open run holds —
 * the first one, root first — or null.
 *
 * Three conditions, all required: a hold by a different run names this very
 * repository; the repository still stands on that hold's branch (a tree moved
 * back to the trunk is free, whoever still holds a record of it); and this
 * claim is not carved away from the hold — the claim's own tree is somewhere
 * else, or it rides the very branch the tree stands on (`claimsDisjoint` with
 * the hold on one side, the same rule `phase-lock.sh conflicts` asks).
 */
export function branchHolderOf(
  trees: readonly TreeRepo[],
  holds: readonly TreeHold[],
  self: { run: string; slug: string },
  claim: { branch?: string; tree?: string },
): BranchHoldView | null {
  for (const tree of trees) {
    if (!tree.branch) continue;
    for (const hold of holds) {
      if (hold.run === self.run) continue;
      if (realish(hold.repo) !== realish(tree.dir) || hold.branch !== tree.branch) continue;
      if (claimsDisjoint({ hold: true, branch: hold.branch, tree: realish(hold.repo) }, claim)) continue;
      return {
        repo: tree.rel || '.', dir: tree.dir, branch: tree.branch, run: hold.run, slug: hold.slug,
        ...(tree.head ? { head: tree.head } : {}),
      };
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * The same rule, synchronously — what an admission scan asks
 * ------------------------------------------------------------------ */

/**
 * The branch a repository's HEAD names, read off disk — no git process. A
 * submodule or a linked worktree keeps a `.git` FILE pointing at its git
 * directory; a detached HEAD names no branch.
 */
export function headBranchSync(repo: string): string | undefined {
  try {
    let gitDir = join(repo, '.git');
    if (statSync(gitDir).isFile()) {
      const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitDir, 'utf8'))?.[1]?.trim();
      if (!pointer) return undefined;
      gitDir = resolve(repo, pointer);
    }
    return /^ref:\s*refs\/heads\/(.+)$/.exec(readFileSync(join(gitDir, 'HEAD'), 'utf8').trim())?.[1];
  } catch {
    return undefined;
  }
}

/**
 * The ONE branch every repository a scope names stands on, read off disk — or
 * undefined when they disagree, one is detached, or the scope is `all`
 * (control-tower phase 90, #149's comment of 2026-09-26T19:13Z).
 *
 * What a shared-checkout run that names no branch of its own commits on: a
 * default-branch run takes the branch it finds. Its claim stated no branch at
 * all, so the carve-out that let a sibling shared run (one stating `pe/<slug>`)
 * past an isolated run's grant in another tree could never apply to it — an
 * unqualified claim collides with everything, and a tamagui-upgrade phase
 * waited out an L-size closeout in a tree it never touched. Only the
 * repositories the scope NAMES are read; `all` reaches every repository, which
 * one branch name cannot describe, so it stays unqualified.
 */
export function standingBranchSync(root: string, scope: readonly string[]): string | undefined {
  const top = realish(root);
  const own = normalizeToken(basename(top));
  const repos = new Set<string>();
  for (const raw of scope) {
    const token = normalizeToken(raw);
    if (!token) continue;
    if (token === 'all') return undefined;
    if (own && token === own) {
      repos.add(top);
      continue;
    }
    const path = resolve(top, token);
    if (!existsSync(path)) return undefined;
    const repo = repoTopSync(statSync(path).isDirectory() ? realish(path) : dirname(realish(path)), top);
    if (!repo) return undefined;
    repos.add(repo);
  }
  let branch: string | undefined;
  for (const repo of repos) {
    const head = headBranchSync(repo);
    if (!head || (branch && head !== branch)) return undefined;
    branch = head;
  }
  return branch;
}

/** The repository a path lives in: the nearest directory at or above it holding `.git`, never above `root`. */
function repoTopSync(path: string, root: string): string | undefined {
  for (let dir = path; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return dir;
    if (dir === root || dir === dirname(dir) || !dir.startsWith(root)) return undefined;
  }
}

/**
 * Does a scope, under `root`, reach this repository? The synchronous twin of
 * `reposUnder` for one repository, and of `hold_in_scope` in `scripts/scope.sh`:
 * `all` or the root's own name reaches the root and every repository under
 * it; any other token reaches the repository its path is in and every one
 * under that — a superproject scope considers its submodules.
 */
export function scopeReaches(root: string, scope: readonly string[], repo: string): boolean {
  const top = realish(root);
  const target = realish(repo);
  const own = normalizeToken(basename(top));
  for (const raw of scope.length ? scope : ['all']) {
    const token = normalizeToken(raw);
    if (!token) continue;
    let base: string | undefined;
    if (token === 'all' || (own && token === own)) {
      base = top;
    } else {
      const path = resolve(top, token);
      if (!existsSync(path)) continue;
      base = repoTopSync(statSync(path).isDirectory() ? realish(path) : dirname(realish(path)), top);
    }
    if (!base) continue;
    if (target === base) return true;
    if (target.startsWith(`${base}${sep}`) && !target.slice(base.length).includes(`${sep}.worktrees${sep}`)) return true;
  }
  return false;
}

/**
 * Which repositories a phase's branch hold may REACH — `scopeReaches`,
 * NARROWED for the root's own name (control-tower phase 90, #150).
 *
 * A branch hold protects a phase from building on a repository another run
 * has checked out onto its own branch, and the phases it protects are the ones
 * that would stage or bump that repository's gitlink or check it out: the ones
 * whose scope NAMES it (or a path in it). The root's own name reached every
 * submodule under it, so a hub-root phase — a closeout that commits docs by
 * explicit pathspec — waited for the whole life of any other run holding any
 * submodule: vca-refactor's P11 open-ended behind shop-frontend's 13
 * remaining phases, observability-plane's P28 for 10 h 51 min. Now the root's
 * name reaches the ROOT repository alone; every other token reaches exactly
 * what it did (phase 40's admission stands for them), and `all` — the
 * undeclared scope — still reaches everything.
 */
export function holdReach(root: string, scope: readonly string[]): (repo: string) => boolean {
  const top = realish(root);
  const own = normalizeToken(basename(top));
  const tokens = scope.map((raw) => normalizeToken(raw)).filter(Boolean);
  const named = own ? tokens.filter((token) => token !== own) : tokens;
  const rootNamed = named.length !== tokens.length;
  return (repo: string): boolean => {
    const target = realish(repo);
    if (rootNamed && target === top) return true;
    // Only the root's name was given: nothing else is reached. (`scopeReaches`
    // reads an EMPTY scope as `all`, which is exactly the widening undone here.)
    if (!named.length) return !tokens.length && scopeReaches(top, [], target);
    return scopeReaches(top, named, target);
  };
}

/**
 * `branchHolderOf` over facts gathered WITHOUT a git process — the probe an
 * admission scan asks (`AdmitRequest.branchHold`). Synchronous, and only as
 * expensive as the holds on this machine: a scope no hold reaches reads
 * nothing at all. Joining the queue never waits on it, so first-come order
 * among a run's own admissions is kept.
 */
export function branchHoldNow(
  root: string,
  scope: readonly string[],
  holds: readonly TreeHold[],
  self: { run: string; slug: string },
  claim: { branch?: string; tree?: string },
): BranchHoldView | null {
  const top = realish(root);
  const trees: TreeRepo[] = [];
  const reach = holdReach(top, scope);
  for (const hold of holds) {
    if (hold.run === self.run) continue;
    const dir = realish(hold.repo);
    if (trees.some((tree) => tree.dir === dir) || !reach(dir)) continue;
    const branch = headBranchSync(dir);
    trees.push({ rel: dir === top ? '' : relative(top, dir), dir, ...(branch ? { branch } : {}) });
  }
  trees.sort((a, b) => depth(a.rel) - depth(b.rel) || a.rel.localeCompare(b.rel));
  return branchHolderOf(trees, holds, self, claim);
}

/** A repository of this scope on a `pe/` branch that is not this plan's, with its holder when one is on record. */
export type ForeignTree = TreeRepo & { branch: string; holder?: { run: string; slug: string } };

/** The repositories a boot prompt must warn about. */
export function foreignTrees(trees: readonly TreeRepo[], holds: readonly TreeHold[], slug: string): ForeignTree[] {
  const out: ForeignTree[] = [];
  for (const tree of trees) {
    if (!tree.branch || !planOfBranch(tree.branch) || ownBranch(tree.branch, slug)) continue;
    const hold = holds.find((h) => realish(h.repo) === realish(tree.dir) && h.branch === tree.branch);
    out.push({ ...tree, branch: tree.branch, ...(hold ? { holder: { run: hold.run, slug: hold.slug } } : {}) });
  }
  return out;
}

/** The loud block a boot prompt carries when its scope stands on another plan's branch. Empty when none does. */
export function foreignTreeWarning(foreign: readonly ForeignTree[], ownBranchName: string | undefined): string {
  if (!foreign.length) return '';
  const lines = foreign.map((tree) => {
    const who = tree.holder
      ? `run ${tree.holder.run} of plan \`${tree.holder.slug}\` holds it and has not settled`
      : `the branch of plan \`${planOfBranch(tree.branch)}\`; no open run holds it`;
    return `  - \`${tree.rel || '.'}\` stands on \`${tree.branch}\`${tree.head ? ` at ${tree.head.slice(0, 10)}` : ''} — ${who}.`;
  });
  return '\n\n⚠ ANOTHER PLAN\'S BRANCH IS CHECKED OUT IN YOUR SCOPE — read this before anything else:\n'
    + `${lines.join('\n')}\n`
    + '  Anything you build, test or verify there reads THAT plan\'s work, not this one\'s: a red\n'
    + '  gate can be a false red and a green one a false green. Before you edit, build or verify\n'
    + `  in it, move it onto ${ownBranchName ? `\`${ownBranchName}\`` : 'the branch this phase needs (the trunk)'} — never commit on another plan's branch —\n`
    + '  and if you cannot move it (it is dirty, or another session is in it), stop and hand off\n'
    + '  `blocked` naming the repository and the branch.\n';
}

/* ------------------------------------------------------------------ *
 * Verification stamps
 * ------------------------------------------------------------------ */

/** Directories a verification command names with `cd <dir>` or `git -C <dir>`, resolved against its cwd. */
export function namedDirs(text: string, cwd: string): string[] {
  const out = new Set<string>();
  const re = /(?:^|[\s;&|(`])(?:cd|pushd)\s+("[^"]+"|'[^']+'|[^\s;&|)`]+)|\bgit\s+-C\s+("[^"]+"|'[^']+'|[^\s;&|)`]+)/g;
  for (const match of text.matchAll(re)) {
    const raw = (match[1] ?? match[2] ?? '').replace(/^["']|["']$/g, '');
    if (!raw || raw === '-' || raw.includes('$')) continue;
    out.add(isAbsolute(raw) ? raw : resolve(cwd, raw));
  }
  return [...out];
}

/**
 * `{repo, branch, head}` for every repository one verification compared
 * against: the one it ran in, every scoped one, every one a command named,
 * and every other repository under the run's root — capped at `STAMP_CAP`.
 */
export async function stampTrees(opts: {
  root: string; cwd: string; scope: readonly string[]; text?: string;
}): Promise<TreeStamp[]> {
  const root = realish(opts.root);
  // `all` from the root, and the scope on its own: a mirror whose root is a
  // plain directory holds its mounts under it with no `.gitmodules` to say so.
  const inScope = await readTrees(root, opts.scope);
  const all = [...await readTrees(root, ['all']), ...inScope]
    .filter((repo, i, list) => (repo.branch || repo.head) && list.findIndex((other) => other.dir === repo.dir) === i);
  const scoped = new Set(inScope.map((repo) => repo.dir));
  const cwd = realish(opts.cwd);
  const verifyIn = [...all].sort((a, b) => b.dir.length - a.dir.length)
    .find((repo) => cwd === repo.dir || cwd.startsWith(`${repo.dir}${sep}`));
  const named = new Set<string>();
  for (const dir of namedDirs(opts.text ?? '', cwd)) {
    const top = [...all].sort((a, b) => b.dir.length - a.dir.length)
      .find((repo) => realish(dir) === repo.dir || realish(dir).startsWith(`${repo.dir}${sep}`));
    if (top) named.add(top.dir);
    else if (existsSync(join(dir, '.git'))) named.add(realish(dir));
  }
  const outside = [...named].filter((dir) => !all.some((repo) => repo.dir === dir));
  const extra = await Promise.all(outside.map(async (dir) => {
    const [branch, head] = await Promise.all([baseBranch(dir), commitOf(dir, 'HEAD')]);
    return { rel: dir, dir, ...(branch ? { branch } : {}), ...(head ? { head } : {}) } as TreeRepo;
  }));
  const roleOf = (repo: TreeRepo): TreeStamp['role'] => (repo.dir === verifyIn?.dir ? 'verify-in'
    : scoped.has(repo.dir) ? 'scope' : named.has(repo.dir) ? 'named' : 'sibling');
  const rank: Record<TreeStamp['role'], number> = { 'verify-in': 0, scope: 1, named: 2, sibling: 3 };
  return [...all, ...extra]
    .map((repo) => ({
      repo: repo.dir === root ? basename(root) : repo.rel || '.',
      branch: repo.branch ?? null, head: repo.head ?? null, role: roleOf(repo),
    }))
    .sort((a, b) => rank[a.role] - rank[b.role])
    .slice(0, STAMP_CAP);
}

/** `repo@branch head` — the words a verdict names what it compared with. */
export function stampWords(stamp: Pick<TreeStamp, 'repo' | 'branch' | 'head'>): string {
  return `${stamp.repo}@${stamp.branch ?? 'detached'} ${stamp.head ? stamp.head.slice(0, 10) : '(no commit)'}`;
}

/**
 * The clause a verify-failed halt's FIRST line carries: what the commands were
 * compared against — the repository they ran in and every scoped one, then a
 * count of the rest. Empty for a record stored before stamps existed.
 */
export function comparedClause(stamps: readonly TreeStamp[] | undefined): string {
  if (!stamps?.length) return '';
  const lead = stamps.filter((stamp) => stamp.role === 'verify-in' || stamp.role === 'scope' || stamp.role === 'named');
  const shown = (lead.length ? lead : stamps).slice(0, 4);
  const more = stamps.length - shown.length;
  return ` (compared against ${shown.map(stampWords).join(', ')}${more > 0 ? ` and ${more} more repositor${more === 1 ? 'y' : 'ies'}` : ''})`;
}
