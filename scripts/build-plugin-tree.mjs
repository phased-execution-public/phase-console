#!/usr/bin/env node
/**
 * build-plugin-tree.mjs — the plugin Claude Code loads, materialized from one
 * revision of this repository (measured-console phase 10, the audit's A11).
 *
 * The repository root is the plugin today (`.claude-plugin/marketplace.json`,
 * `source: "./"`), so every install copied all of it — the console, its tests,
 * a 33 MB screencast — to load one SKILL.md and the scripts it names. This
 * writes the skill and only the skill:
 *
 *   SKILL.md · references/ · scripts/ · templates/ · hooks/hooks.json ·
 *   viewer/shared/instances.mjs and what it imports (the hook and the scripts
 *   resolve an instance through it) · LICENSE ·
 *   .claude-plugin/plugin.json · .claude-plugin/marketplace.json (one entry,
 *   `source: "./"`, so the tree is a marketplace of itself) ·
 *   plugin-stamp.json — the revision and the skill's interface (`PE_API`)
 *
 * The repository root keeps NO `plugin.json` (its CLAUDE.md: the folder stays a
 * valid bare skill); only the tree has one. The tree is deterministic — the same
 * revision gives the same bytes, so a commit of it (update-plugin.sh's `plugin`
 * branch) moves only when the skill did — and at most MAX_BYTES, asserted.
 *
 *   node scripts/build-plugin-tree.mjs --out DIR [--rev REV | --worktree] [--root DIR] [--quiet] [--json]
 *
 *   --out DIR    where the tree goes; replaced whole (refused when DIR holds
 *                something that is not a tree of this script's)
 *   --rev REV    the revision to read (default HEAD); --worktree reads the files
 *                on disk instead (what a checkout with no git — a package — has)
 *   --root DIR   the repository (default: this script's own)
 *   --quiet      print nothing on success; --json prints the summary as JSON
 *
 * Exit 0 built · 1 the tree is over MAX_BYTES or a source file is missing · 2 usage.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The ceiling the plan sets: 5 MB, the tree's whole byte count. */
export const MAX_BYTES = 5 * 1024 * 1024;
/** The skill's directories and files, as the tree carries them. */
export const TREE_PATHS = ['SKILL.md', 'references', 'scripts', 'templates', 'hooks/hooks.json', 'LICENSE'];
/** The one console module the scripts reach for (`instance.sh`, `session-hook.sh`), closed over its imports. */
export const TREE_ENTRY_MODULES = ['viewer/shared/instances.mjs'];
export const STAMP_FILE = 'plugin-stamp.json';
const MARKER = '.plugin-tree';
const SKIP = new Set(['.DS_Store']);

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** A reader over one revision (git) or the working tree. */
function source(root, rev) {
  if (rev === null) {
    return {
      rev: null,
      exists: (rel) => existsSync(join(root, rel)),
      isDir: (rel) => statSync(join(root, rel)).isDirectory(),
      list: (rel) => {
        const out = [];
        const walk = (sub) => {
          for (const name of readdirSync(join(root, sub)).sort()) {
            if (SKIP.has(name)) continue;
            const child = posix.join(sub, name);
            if (statSync(join(root, child)).isDirectory()) walk(child); else out.push(child);
          }
        };
        walk(rel);
        return out;
      },
      read: (rel) => readFileSync(join(root, rel)),
      mode: (rel) => statSync(join(root, rel)).mode & 0o777,
    };
  }
  const git = (args, opts = {}) => execFileSync('git', ['-C', root, ...args], { maxBuffer: 256 * 1024 * 1024, ...opts });
  const full = String(git(['rev-parse', '--verify', `${rev}^{commit}`])).trim();
  /** path → [mode, kind] for every entry under the paths asked about. */
  const entries = new Map();
  const listing = String(git(['ls-tree', '-r', '-t', '-z', full, '--', ...TREE_PATHS, 'viewer/shared', 'package.json', '.claude-plugin/marketplace.json']));
  for (const line of listing.split('\0')) {
    if (!line) continue;
    const tab = line.indexOf('\t');
    const [mode, kind] = line.slice(0, tab).split(' ');
    entries.set(line.slice(tab + 1), { mode, kind });
  }
  // Every blob at once, through ONE `git cat-file --batch`: a console builds
  // its tree at each boot, and a process per file was a second of git.
  const blobs = [...entries].filter(([, e]) => e.kind === 'blob').map(([p]) => p);
  const bodies = new Map();
  const batch = git(['cat-file', '--batch'], { input: blobs.map((p) => `${full}:${p}`).join('\n') + '\n' });
  let at = 0;
  for (const p of blobs) {
    const nl = batch.indexOf(0x0a, at);
    const size = Number(batch.subarray(at, nl).toString('utf8').split(' ')[2]);
    bodies.set(p, batch.subarray(nl + 1, nl + 1 + size));
    at = nl + 1 + size + 1;
  }
  return {
    rev: full,
    exists: (rel) => entries.has(rel),
    isDir: (rel) => entries.get(rel)?.kind === 'tree',
    list: (rel) => [...entries.keys()]
      .filter((p) => p.startsWith(`${rel}/`) && entries.get(p).kind === 'blob' && !SKIP.has(posix.basename(p)))
      .sort(),
    read: (rel) => bodies.get(rel) ?? git(['cat-file', 'blob', `${full}:${rel}`]),
    mode: (rel) => (entries.get(rel)?.mode === '100755' ? 0o755 : 0o644),
  };
}

/** `viewer/shared/instances.mjs` and every relative module it imports, transitively. */
function moduleClosure(src, entries) {
  const seen = new Set();
  const queue = [...entries];
  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel) || !src.exists(rel)) continue;
    seen.add(rel);
    const text = src.read(rel).toString('utf8');
    for (const match of text.matchAll(/\bfrom\s+['"](\.{1,2}\/[^'"]+)['"]|\bimport\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
      queue.push(posix.normalize(posix.join(posix.dirname(rel), match[1] ?? match[2])));
    }
  }
  return [...seen].sort();
}

function readJson(src, rel) {
  try { return src.exists(rel) ? JSON.parse(src.read(rel).toString('utf8')) : null; } catch { return null; }
}

/** `KEY=VALUE` pairs of a sourced env file. */
function envPairs(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const m = /^([A-Z_][A-Z0-9_]*)="?([^"\n]*)"?\s*$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** The console's own entry of the repository's marketplace, cut to what the tree's manifest says. */
function consoleEntry(src) {
  const market = readJson(src, '.claude-plugin/marketplace.json');
  const entry = market?.plugins?.find?.((one) => one?.source === './') ?? market?.plugins?.[0] ?? {};
  return { market, entry };
}

/** The description's first paragraph, under the listing's 1,536-character entry cap. */
export function firstParagraph(text, max = 1536) {
  const para = String(text ?? '').split(/\n\s*\n/)[0].replace(/\s+/g, ' ').trim();
  return para.length <= max ? para : `${para.slice(0, max - 1).replace(/\s+\S*$/, '')}…`;
}

/**
 * Build the tree. Returns the summary: `{ out, rev, peApi, files, bytes }`.
 * @param {{ out: string, root?: string, rev?: string|null }} options  `rev: null` reads the working tree
 */
export function buildPluginTree({ out, root = HERE, rev = 'HEAD' }) {
  const src = source(root, rev);
  const files = [];
  for (const rel of TREE_PATHS) {
    if (!src.exists(rel)) throw new Error(`build-plugin-tree: ${rel} is not in ${src.rev ?? 'the working tree'}`);
    if (src.isDir(rel)) files.push(...src.list(rel)); else files.push(rel);
  }
  files.push(...moduleClosure(src, TREE_ENTRY_MODULES));

  const { market, entry } = consoleEntry(src);
  const pkg = readJson(src, 'package.json') ?? {};
  const api = src.exists('scripts/skill-api.env') ? envPairs(src.read('scripts/skill-api.env').toString('utf8')) : {};
  const short = src.rev ? src.rev.slice(0, 12) : 'worktree';
  const name = entry.name ?? 'phased-execution';
  const manifest = {
    name,
    // The version Claude Code caches the install under: the revision, so an
    // update moves exactly when the skill did.
    version: short,
    description: firstParagraph(entry.description ?? ''),
    ...(entry.author ? { author: entry.author } : {}),
    ...(entry.homepage ? { homepage: entry.homepage } : {}),
    ...(entry.repository ? { repository: entry.repository } : {}),
    ...(entry.license ? { license: entry.license } : {}),
    ...(entry.keywords ? { keywords: entry.keywords } : {}),
    // No `hooks` key: `hooks/hooks.json` is loaded by its place, and naming it
    // here as well would MERGE the file with itself — every hook twice.
  };
  const marketplace = {
    name: market?.name ?? 'phased-execution-public',
    ...(market?.description ? { description: market.description } : {}),
    owner: market?.owner ?? { name: 'phased-execution-public' },
    plugins: [{
      name,
      source: './',
      description: manifest.description,
      ...(entry.author ? { author: entry.author } : {}),
      ...(entry.license ? { license: entry.license } : {}),
      ...(entry.category ? { category: entry.category } : {}),
    }],
  };
  const stamp = {
    rev: src.rev,
    version: pkg.version ?? null,
    peApi: api.PE_API ? Number(api.PE_API) : null,
    peApiMin: api.PE_API_MIN ? Number(api.PE_API_MIN) : null,
    files: files.length + 3,
  };

  const dest = resolve(out);
  if (existsSync(dest) && readdirSync(dest).length && !existsSync(join(dest, MARKER))) {
    throw new Error(`build-plugin-tree: ${dest} holds something that is not a plugin tree — refusing to replace it`);
  }
  const staging = `${dest}.tmp-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  let bytes = 0;
  const put = (rel, body, mode = 0o644) => {
    const at = join(staging, rel);
    mkdirSync(dirname(at), { recursive: true });
    writeFileSync(at, body, { mode });
    bytes += Buffer.byteLength(body);
  };
  for (const rel of files) put(rel, src.read(rel), src.mode(rel));
  put('.claude-plugin/plugin.json', `${JSON.stringify(manifest, null, 2)}\n`);
  put('.claude-plugin/marketplace.json', `${JSON.stringify(marketplace, null, 2)}\n`);
  stamp.bytes = bytes;
  put(STAMP_FILE, `${JSON.stringify(stamp, null, 2)}\n`);
  writeFileSync(join(staging, MARKER), '');
  if (bytes > MAX_BYTES) {
    rmSync(staging, { recursive: true, force: true });
    throw Object.assign(new Error(`build-plugin-tree: the tree is ${bytes} bytes, over the ${MAX_BYTES}-byte ceiling`), { over: true });
  }
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dirname(dest), { recursive: true });
  renameSync(staging, dest);
  return { out: dest, rev: src.rev, peApi: stamp.peApi, files: stamp.files, bytes: stamp.bytes };
}

function main(argv) {
  let out = null; let rev = 'HEAD'; let root = HERE; let quiet = false; let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out' && argv[i + 1]) out = argv[++i];
    else if (a === '--rev' && argv[i + 1]) rev = argv[++i];
    else if (a === '--worktree') rev = null;
    else if (a === '--root' && argv[i + 1]) root = resolve(argv[++i]);
    else if (a === '--quiet') quiet = true;
    else if (a === '--json') json = true;
    else if (a === '-h' || a === '--help') {
      process.stdout.write(`${readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(2, 33).map((l) => l.replace(/^ \* ?/, '')).join('\n')}\n`);
      return 0;
    } else { process.stderr.write(`build-plugin-tree: unknown argument: ${a} (see --help)\n`); return 2; }
  }
  if (!out) { process.stderr.write('build-plugin-tree: --out DIR is required\n'); return 2; }
  try {
    const summary = buildPluginTree({ out, root, rev });
    if (json) process.stdout.write(`${JSON.stringify(summary)}\n`);
    else if (!quiet) process.stdout.write(`plugin tree ${summary.out} — ${summary.files} files, ${summary.bytes} bytes, rev ${summary.rev ?? 'worktree'}, PE_API ${summary.peApi}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
