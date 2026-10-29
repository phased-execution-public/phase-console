/**
 * The plugin seed, read (measured-console phase 10, §Architecture 6 D1): which
 * seed this machine carries, how old it is, and the one variable a session is
 * handed to load it — `CLAUDE_CODE_PLUGIN_SEED_DIR`, whatever its
 * `CLAUDE_CONFIG_DIR` (phase 11 hands it out).
 *
 * The seed is built by `scripts/build-seed.sh` under `<state home>/seed/<digest>/`
 * — `seed.json`, `THIRD-PARTY-NOTICES` and `plugins/`, a Claude Code plugins
 * root, read-only — and `<state home>/seed/current.json` names the current one.
 * Reading is all this module does, and it never throws: a machine with no
 * seed answers null, and the doctor row says how to build one.
 *
 * A leaf like `skill-copy.ts`: nothing here resolves an instance at module
 * load, so `bin/phase-console.mjs` imports it for `seed status`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { stateHome } from '../shared/instances.mjs';
import type { ProbeVerdict } from './prelude.ts';

/** The variable a session loads the seed through. */
export const SEED_ENV = 'CLAUDE_CODE_PLUGIN_SEED_DIR';
/** What the seed's builder writes beside the plugins. */
export const SEED_FILE = 'seed.json';
export const SEED_NOTICES = 'THIRD-PARTY-NOTICES';

export type SeedEntry = {
  name: string;
  source: string;
  sha: string | null;
  commit: string | null;
  version: string | null;
  license: string;
  skills?: string[];
  installPath: string;
  bytes: number;
  notices: { holder: string; license: string; for?: string }[];
  alias?: string;
};

export type SeedFacts = {
  digest: string;
  /** `<state home>/seed/<digest>`. */
  dir: string;
  /** The plugins root a session is pointed at (`SEED_ENV`). */
  pluginsDir: string;
  notices: string;
  marketplace: string;
  builtAt: string;
  ageMs: number;
  bytes: number;
  entries: SeedEntry[];
  format: number | null;
};

/** `<state home>/seed`. */
export function seedRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(stateHome(env), 'seed');
}

export type SeedRead = { seed: SeedFacts | null; problem?: string };

/** The current seed, or why there is none a session could load. */
export function readSeed(env: NodeJS.ProcessEnv = process.env, now: number = Date.now()): SeedRead {
  const root = seedRoot(env);
  let digest: string;
  try {
    digest = String(JSON.parse(readFileSync(join(root, 'current.json'), 'utf8')).digest ?? '');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { seed: null };
    return { seed: null, problem: `${join(root, 'current.json')} does not parse — ${(error as Error).message}` };
  }
  if (!/^[0-9a-f]{12}$/.test(digest)) return { seed: null, problem: `${join(root, 'current.json')} names no seed digest` };
  const dir = join(root, digest);
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(readFileSync(join(dir, SEED_FILE), 'utf8')) as Record<string, unknown>;
  } catch (error) {
    return { seed: null, problem: `the current seed ${digest} has no readable ${SEED_FILE} — ${(error as Error).message}` };
  }
  const pluginsDir = join(dir, typeof doc.pluginsDir === 'string' ? doc.pluginsDir : 'plugins');
  if (!existsSync(join(pluginsDir, 'installed_plugins.json'))) {
    return { seed: null, problem: `the current seed ${digest} has no plugins root at ${pluginsDir}` };
  }
  const builtAt = typeof doc.builtAt === 'string' ? doc.builtAt : '';
  const at = Date.parse(builtAt);
  return {
    seed: {
      digest, dir, pluginsDir,
      notices: join(dir, SEED_NOTICES),
      marketplace: typeof doc.marketplace === 'string' ? doc.marketplace : 'phased-execution-seed',
      builtAt,
      ageMs: Number.isFinite(at) ? Math.max(0, now - at) : 0,
      bytes: typeof doc.bytes === 'number' ? doc.bytes : 0,
      entries: Array.isArray(doc.entries) ? (doc.entries as SeedEntry[]) : [],
      format: typeof doc.format === 'number' ? doc.format : null,
    },
  };
}

/** The environment a session loads the seed with — empty when this machine has none. */
export function seedEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const { seed } = readSeed(env);
  return seed ? { [SEED_ENV]: seed.pluginsDir } : {};
}

/** An age in the largest unit that fits: `3 d`, `5 h`, `12 min`, `40 s`. */
export function ageWords(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s} s`;
  if (s < 90 * 60) return `${Math.round(s / 60)} min`;
  if (s < 36 * 3600) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} d`;
}

/** One line: the digest, the age, the entries. */
export function describeSeed(seed: SeedFacts): string {
  return `seed ${seed.digest} — built ${seed.builtAt} (${ageWords(seed.ageMs)} ago), ${seed.entries.length} plugins `
    + `(${seed.entries.map((e) => e.name).join(', ')}), ${seed.bytes} bytes, at ${seed.pluginsDir}`;
}

/**
 * The doctor's `seed` row. Never blocking: a machine with no seed runs every
 * session as before, with the plugins its config dirs carry.
 */
export function seedVerdict(read: SeedRead | null): ProbeVerdict {
  if (!read) return { status: 'skip', ok: true, reason: 'the seed was not read' };
  if (read.problem) return { status: 'fail', ok: false, reason: `${read.problem} — rebuild it with phase-console seed build --force` };
  if (!read.seed) return { status: 'skip', ok: true, reason: 'no plugin seed is built on this machine — phase-console seed build makes one' };
  const { seed } = read;
  return {
    status: 'ok', ok: true,
    reason: `${seed.digest}, built ${ageWords(seed.ageMs)} ago — ${seed.entries.length} plugins: `
      + `${seed.entries.map((e) => `${e.name} (${e.license}${e.sha ? ` @ ${e.sha.slice(0, 12)}` : ''})`).join(', ')}`,
  };
}
