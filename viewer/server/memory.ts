/**
 * The third artefact of the trio: the durable `project_<slug>` memory entry.
 *
 * Memory lives outside the source directory, under the Claude home(s), and the
 * plan's `memory:` key may point at a pre-existing entry whose name differs
 * from the slug. Both spellings are searched — `project_<slug>.md` and
 * `project-<slug>.md` — because both exist in the wild.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { safeList } from './config.ts';

export type MemoryEntry = {
  key: string;
  path: string;
  text: string;
  mtime: number;
};

/**
 * How long a memory lookup is reused.
 *
 * These three functions walk every Claude home's `projects/*` looking for a
 * `memory` directory — roughly 900 blocking `existsSync`/`readdir` calls on
 * this machine — and a plan detail asked for all of it TWICE per request, to
 * fill one sidebar panel. The answer only moves when a session writes a memory
 * file, which is minutes apart at the very fastest, so a few seconds of
 * staleness costs nothing while the syscalls cost a visible part of a page load.
 *
 * Short rather than clever on purpose: no watcher, no invalidation protocol,
 * nothing further to keep true. `resetMemoryCache()` is there for tests and for
 * any caller that has just written a memory itself.
 */
const MEMORY_TTL_MS = 5_000;

type Memo<T> = { at: number; value: T };

/**
 * Keyed by HOME, not a bare slot: `homedir()` follows `$HOME`, tests move it,
 * and a memo that ignored it would answer one home's question with another
 * home's directories.
 */
const dirsMemo = new Map<string, Memo<string[]>>();
const entryMemo = new Map<string, Memo<MemoryEntry | undefined>>();
const indexMemo = new Map<string, Memo<string[]>>();

function fresh<T>(memo: Memo<T> | null | undefined, now: number): memo is Memo<T> {
  return Boolean(memo && now - memo.at < MEMORY_TTL_MS);
}

/** Drop every memoized answer — tests, and anything that has just written one. */
export function resetMemoryCache(): void {
  dirsMemo.clear();
  entryMemo.clear();
  indexMemo.clear();
}

/** Every `<claude-home>/projects/<project>/memory` directory on this machine. */
export function memoryDirs(): string[] {
  const now = Date.now();
  const home = homedir();
  const memo = dirsMemo.get(home);
  if (fresh(memo, now)) return memo.value;

  const homes = safeList(home).filter((name) => /^\.claude(-[a-z0-9]+)?$/.test(name)).map((n) => join(home, n));
  const dirs: string[] = [];
  for (const claudeHome of homes) {
    const projects = join(claudeHome, 'projects');
    for (const project of safeList(projects)) {
      const dir = join(projects, project, 'memory');
      if (existsSync(dir)) dirs.push(dir);
    }
  }
  dirsMemo.set(home, { at: now, value: dirs });
  return dirs;
}

/**
 * The memo key for one lookup: the entry key, then the directory list.
 *
 * Joined on NUL because that is the one byte a slug and a filesystem path
 * cannot contain, so no pair of different questions can collide on one key —
 * the same reason `engine.ts` keys its cache that way.
 */
function memoKeyFor(key: string, dirs: string[]): string {
  return [key, ...dirs].join('\u0000');
}

function candidates(key: string): string[] {
  const bare = key.replace(/^project[_-]/, '');
  return [`${key}.md`, `project_${bare}.md`, `project-${bare}.md`, `${bare}.md`];
}

export function findMemory(key: string, dirs = memoryDirs()): MemoryEntry | undefined {
  // Memoized on the key AND the directory list: a caller that passes its own
  // `dirs` is asking a different question and must not be served this one's
  // answer. The default caller passes the memoized list, so the join is a
  // constant string it already had.
  const now = Date.now();
  const memoKey = memoKeyFor(key, dirs);
  const memo = entryMemo.get(memoKey);
  if (fresh(memo, now)) return memo.value;

  const value = readMemory(key, dirs);
  entryMemo.set(memoKey, { at: now, value });
  return value;
}

function readMemory(key: string, dirs: string[]): MemoryEntry | undefined {
  for (const dir of dirs) {
    for (const name of candidates(key)) {
      const path = join(dir, name);
      if (!existsSync(path)) continue;
      try {
        return { key, path, text: readFileSync(path, 'utf8'), mtime: statSync(path).mtimeMs };
      } catch { /* unreadable memory is simply absent */ }
    }
  }
  return undefined;
}

/** The `MEMORY.md` index line(s) mentioning this key, for the "linked from" note. */
export function memoryIndexLines(key: string, dirs = memoryDirs()): string[] {
  const now = Date.now();
  const memoKey = memoKeyFor(key, dirs);
  const memo = indexMemo.get(memoKey);
  if (fresh(memo, now)) return memo.value;

  const value = readIndexLines(key, dirs);
  indexMemo.set(memoKey, { at: now, value });
  return value;
}

function readIndexLines(key: string, dirs: string[]): string[] {
  const bare = key.replace(/^project[_-]/, '');
  const out: string[] = [];
  for (const dir of dirs) {
    const path = join(dir, 'MEMORY.md');
    if (!existsSync(path)) continue;
    try {
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (line.includes(bare) && line.trim().startsWith('-')) out.push(line.trim());
      }
    } catch { /* ignore */ }
  }
  return out;
}
