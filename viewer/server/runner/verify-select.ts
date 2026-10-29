/**
 * The phase tier's selection (measured-console phase 15): what a HEAVY
 * §Verification line runs as, under `**Verification tier:** impact`.
 *
 * Two tiers verify a tree. The release runs every suite and alone writes the
 * marker (`scripts/gates.sh`). A phase verifies what it changed: each heavy line
 * — named in `scripts/verify-select.env`, whose rows were chosen from phase 8's
 * measured stage seconds — runs in its SELECTED form: the test files the
 * phase's diff maps to, plus the invariants, plus a sample of the rest seeded
 * by the boarding sha. Every other line runs as written, and so does a heavy
 * line whose diff touches a file in its scope that no test names: the reader
 * never guesses what such a file is covered by.
 *
 * The ORIGINAL text stays the line's identity everywhere — the ledger's key,
 * the proof's, the baseline's — and the row says how it ran (`tier: 'phase'`,
 * `selected`, `sample`, `covered`). A selected run is never a measurement of
 * the full line, so neither the limit nor a baseline reuses one for the other.
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { parseQuarantine, quarantinedPaths } from '../../shared/quarantine-model.js';

/** The env the selected form runs under — the phase tier, as Playwright's retries and gates.sh's marker read it. */
export const PHASE_TIER_ENV = { PE_VERIFY_TIER: 'phase' } as const;

export type SelectKind = 'bats' | 'node' | 'vitest' | 'playwright';

export type SelectRow = { id: string; line: RegExp; source: string; kind: SelectKind; scope: string[] };

export type SelectTable = { sample: number; invariants: string[]; rows: SelectRow[] };

/** What a heavy line ran as. `covered` is the selected files over the line's planned files, 0–1. */
export type VerifySelection = {
  tier: 'phase';
  /** The command that actually ran. */
  form: string;
  /** The row of the table that selected it. */
  row: string;
  selected: string[];
  sample: string[];
  covered: number;
};

/** A heavy line the phase tier ran as written, and why. */
export type VerifyUnselected = { tier: 'full'; row: string; reason: string };

/** The table's file, under a repository root. */
export function selectTableFile(repoRoot: string): string {
  return join(repoRoot, 'scripts', 'verify-select.env');
}

/** One single-quoted assignment of a sourced env file, unquoted. */
function assignment(text: string, name: string): string | undefined {
  const match = new RegExp(`^${name}=(?:'([^']*)'|(\\S*))`, 'm').exec(text);
  return match ? (match[1] ?? match[2]) : undefined;
}

const KINDS: ReadonlySet<string> = new Set(['bats', 'node', 'vitest', 'playwright']);

/** Parse `verify-select.env` exactly as bash would read its three assignments. */
export function parseSelectTable(text: string): SelectTable {
  const sample = Number(assignment(text, 'VERIFY_SELECT_SAMPLE') ?? '0');
  const invariants = (assignment(text, 'VERIFY_SELECT_INVARIANTS') ?? '').split(/\s+/).filter(Boolean);
  const rows: SelectRow[] = [];
  for (const raw of (assignment(text, 'VERIFY_SELECT_ROWS') ?? '').split('\n')) {
    const [id, source, kind, scope] = raw.split('\t');
    if (!id || !source || !kind || !KINDS.has(kind)) continue;
    rows.push({ id, source, line: new RegExp(source), kind: kind as SelectKind, scope: (scope ?? '').split(/\s+/).filter(Boolean) });
  }
  return { sample: Number.isInteger(sample) && sample >= 0 ? sample : 0, invariants, rows };
}

/** The table at a repository root, or null when it has none (a repository this tier does not know). */
export function readSelectTable(repoRoot: string): SelectTable | null {
  const file = selectTableFile(repoRoot);
  if (!existsSync(file)) return null;
  try { return parseSelectTable(readFileSync(file, 'utf8')); } catch { return null; }
}

/** The row a command is, or undefined when it is not a heavy line. `folded` is `foldCommand`'s text. */
export function rowOf(table: SelectTable, folded: string): SelectRow | undefined {
  return table.rows.find((row) => row.line.test(folded));
}

/**
 * The seeded sample: `count` of `pool`, ordered by a hash of the seed and the
 * path — the same seed draws the same files, wherever and whenever it is asked.
 */
export function sampleOf(pool: readonly string[], seed: string, count: number): string[] {
  const key = (path: string) => createHash('sha1').update(`${seed}:${path}`).digest('hex');
  return [...pool].sort((a, b) => key(a).localeCompare(key(b)) || a.localeCompare(b)).slice(0, Math.max(0, count));
}

/** Every file under `dir` (repository-relative) whose name matches — sorted, `node_modules` and dot-dirs skipped. */
function filesUnder(repoRoot: string, dir: string, name: RegExp): string[] {
  const out: string[] = [];
  const walk = (at: string): void => {
    let entries: string[];
    try { entries = readdirSync(at); } catch { return; }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      const path = join(at, entry);
      let isDir = false;
      try { isDir = statSync(path).isDirectory(); } catch { continue; }
      if (isDir) walk(path);
      else if (name.test(entry)) out.push(relative(repoRoot, path));
    }
  };
  walk(join(repoRoot, dir));
  return out.sort();
}

/**
 * The files `scripts/quarantine.env` sets aside for a suite today — the phase
 * tier never selects or samples one (`shared/quarantine-model.js`).
 */
export function quarantinedFiles(repoRoot: string, kind: SelectKind, now = Date.now()): string[] {
  let text: string;
  try { text = readFileSync(join(repoRoot, 'scripts', 'quarantine.env'), 'utf8'); } catch { return []; }
  return quarantinedPaths(parseQuarantine(text), kind, now);
}

/** The test files a line of each kind would run in full — its planned files, the quarantined left out. */
export function plannedFiles(repoRoot: string, kind: SelectKind): string[] {
  const aside = new Set(quarantinedFiles(repoRoot, kind));
  return allFiles(repoRoot, kind).filter((file) => !aside.has(file));
}

function allFiles(repoRoot: string, kind: SelectKind): string[] {
  switch (kind) {
    case 'bats': return filesUnder(repoRoot, 'tests', /\.bats$/);
    case 'node': return readdirSafe(join(repoRoot, 'viewer', 'test'))
      .filter((name) => name.endsWith('.test.ts')).map((name) => `viewer/test/${name}`).sort();
    case 'vitest': return filesUnder(repoRoot, 'viewer/client/src', /\.test\.tsx?$/);
    case 'playwright': return filesUnder(repoRoot, 'viewer/e2e', /\.spec\.ts$/);
  }
}

function readdirSafe(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

/** The name a test file would use for a changed file: its basename, extension kept. */
const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/**
 * The test files that name a changed file — a bats file naming `phase-graph.sh`,
 * a node test importing `verify-select.ts`. A changed test file is its own.
 * Undefined when the file is in scope and nothing names it: unmapped.
 */
export function testsNaming(repoRoot: string, planned: readonly string[], changed: string): string[] | undefined {
  if (planned.includes(changed)) return [changed];
  const name = basename(changed);
  if (!name) return undefined;
  const hits = planned.filter((file) => {
    try { return readFileSync(join(repoRoot, file), 'utf8').includes(name); } catch { return false; }
  });
  return hits.length ? hits : undefined;
}

/** POSIX single-quoting for a word the selected form passes on. */
const shq = (word: string): string => (/^[A-Za-z0-9_./:=@+-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`);

/**
 * What one heavy line runs as under the phase tier, given the files the phase
 * changed (repository-relative) since `base` and the seed. A selection, or the
 * reason it runs as written; undefined when the line is not heavy at all.
 */
export function selectLine(opts: {
  table: SelectTable; repoRoot: string; folded: string; changed: readonly string[]; base: string; seed: string;
}): VerifySelection | VerifyUnselected | undefined {
  const row = rowOf(opts.table, opts.folded);
  if (!row) return undefined;
  const inScope = opts.changed.filter((path) => row.scope.some((prefix) => path.startsWith(prefix)));
  const planned = plannedFiles(opts.repoRoot, row.kind);
  const covered = (count: number) => (planned.length ? Math.min(1, count / planned.length) : 0);

  if (row.kind === 'playwright') {
    return {
      tier: 'phase', row: row.id, form: `npm --prefix viewer run test:e2e:dist -- --only-changed=${shq(opts.base)}`,
      selected: inScope, sample: [], covered: covered(0),
    };
  }

  if (row.kind === 'vitest') {
    // `vitest related` maps the changed sources to their tests itself — the
    // module graph, not a grep. Paths are relative to viewer/, where it runs.
    const sources = inScope.filter((path) => /\.(tsx?|jsx?|mjs)$/.test(path)).map((path) => path.replace(/^viewer\//, ''));
    const sample = sampleOf(planned.filter((file) => !inScope.includes(file)), opts.seed, opts.table.sample)
      .map((path) => path.replace(/^viewer\//, ''));
    const words = [...sources, ...sample];
    return {
      tier: 'phase', row: row.id, form: `npm --prefix viewer exec -- vitest related --run ${words.map(shq).join(' ')}`,
      selected: sources, sample, covered: covered(sources.filter((path) => /\.test\.tsx?$/.test(path)).length + sample.length),
    };
  }

  const selected = new Set<string>();
  for (const path of inScope) {
    const hits = testsNaming(opts.repoRoot, planned, path);
    if (!hits) return { tier: 'full', row: row.id, reason: `${path} is in this line's scope and no test file names it` };
    for (const hit of hits) selected.add(hit);
  }
  const invariants = row.kind === 'node' ? opts.table.invariants.filter((file) => planned.includes(file)) : [];
  const chosen = [...new Set([...selected, ...invariants])].sort();
  const sample = sampleOf(planned.filter((file) => !chosen.includes(file)), opts.seed, opts.table.sample);
  const files = [...chosen, ...sample];
  const form = row.kind === 'bats'
    ? `RUN_TESTS_ONLY=${shq(files.join(' '))} bash tests/run-tests.sh`
    : `node --test --test-timeout=600000 --test-force-exit --test-concurrency=4 ${files.map(shq).join(' ')}`;
  return { tier: 'phase', row: row.id, form, selected: chosen, sample, covered: covered(files.length) };
}

/**
 * The files changed since `base` in the repository at `repoRoot` — committed,
 * staged, unstaged and untracked — repository-relative. Null when git cannot
 * say (no such commit): the caller then runs every line as written.
 */
export function changedSince(repoRoot: string, base: string): string[] | null {
  const git = (args: string[]) => spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' });
  const diff = git(['diff', '--name-only', base, '--']);
  if (diff.status !== 0) return null;
  const untracked = git(['ls-files', '--others', '--exclude-standard']);
  const lines = `${diff.stdout}\n${untracked.status === 0 ? untracked.stdout : ''}`.split('\n').map((line) => line.trim());
  return [...new Set(lines.filter(Boolean))].sort();
}
