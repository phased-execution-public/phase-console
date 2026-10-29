/**
 * The node suite's one repository fixture (measured-console phase 15). Before
 * it, 45 files each defined a `function repo()` of their own (the 2026-10-17
 * audit, evidence/local-testing.md §8.2): two shapes, rewritten file by file.
 *
 *  - `repo()` — a real git repository: `git init -b main`, an identity, the
 *    files given, one commit. The recipe that does not flake: the identity is
 *    set in the repository (never read from the machine), and every git call
 *    runs with the console's `GIT_*` variables unset, so a test run from a
 *    hook or a submodule does not write into the checkout around it.
 *  - `stubRepo()` — the scaffold a runner test drives: a temp root holding
 *    `scripts/` (the stub engine, each file executable), a state directory the
 *    stubs read (`done` empty), `docs/plans/<slug>.md`, `markDone` and
 *    `cleanup`. What differs between files — the stub scripts — is theirs.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** git's own variables, unset, so a call never reaches the checkout around the test. */
const GIT_ENV_UNSET = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX', 'GIT_OBJECT_DIRECTORY'];

function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of GIT_ENV_UNSET) delete env[name];
  return env;
}

/** Run git in `dir`; its stdout, trimmed. Throws on a non-zero exit, as `execFileSync` does. */
export function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: gitEnv(), stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** `git`, with `extra` added to the environment (a pinned commit date, say). */
function gitWith(dir: string, extra: NodeJS.ProcessEnv, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...gitEnv(), ...extra }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Write a file, its directories first; `mode` makes it executable (`0o755`). */
export function put(path: string, body: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, 'utf8');
  if (mode !== undefined) chmodSync(path, mode);
}

export type RepoOptions = {
  /** Where — created if missing. Default: a fresh temp directory named by `prefix`. */
  dir?: string;
  /** The temp directory's prefix when `dir` is not given. Default `pc-repo-`. */
  prefix?: string;
  /** Files of the first commit, path → text. Default: `README.md`. */
  files?: Record<string, string>;
  /** The branch `init` makes. Default `main`; `null` leaves git's own default. */
  branch?: string | null;
  /** The first commit's message. Default `seed`. `commit: false` makes none. */
  message?: string;
  commit?: boolean;
  /** Pin the first commit's author and committer date (any date git reads). Default: now. */
  date?: string;
};

/** A git repository with one commit (or none, `commit: false`); its path. */
export function repo(opts: RepoOptions = {}): string {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), opts.prefix ?? 'pc-repo-'));
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', ...(opts.branch === null ? [] : ['-b', opts.branch ?? 'main']));
  git(dir, 'config', 'user.email', 't@example.invalid');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'commit.gpgsign', 'false');
  const files = opts.files ?? { 'README.md': '# README.md\n' };
  for (const [path, text] of Object.entries(files)) put(join(dir, path), text);
  if (opts.commit !== false) {
    git(dir, 'add', '-A');
    gitWith(dir, opts.date ? { GIT_AUTHOR_DATE: opts.date, GIT_COMMITTER_DATE: opts.date } : {}, 'commit', '-q', '--allow-empty', '-m', opts.message ?? 'seed');
  }
  return dir;
}

/** The paths a stub repository's scripts are written against. */
export type StubPaths = { root: string; scripts: string; state: string };

export type StubRepo = StubPaths & {
  /** Append a phase to `<state>/done` — the stub engine's done set. */
  markDone: (phase: number) => void;
  cleanup: () => void;
};

export type StubRepoOptions = {
  /** The temp directory's prefix. */
  prefix: string;
  /** The root itself, when the test owns the parent directory (cleanup removes it). Default: a fresh temp directory. */
  dir?: string;
  /** The stub scripts under `scripts/`, name → body, written executable. A function is given the paths. */
  scripts?: Record<string, string> | ((paths: StubPaths) => Record<string, string>);
  /** Files of the state directory beside `done`, name → text. */
  state?: Record<string, string>;
  /** The state directory's name under the root. Default `.stub`. */
  stateDir?: string;
  /** The plan the docs root holds. Default `demo`. `null`: no docs root at all. */
  plan?: string | null;
};

/** The scaffold a runner test drives over stub scripts. */
export function stubRepo(opts: StubRepoOptions): StubRepo {
  const root = opts.dir ?? mkdtempSync(join(tmpdir(), opts.prefix));
  const scripts = join(root, 'scripts');
  const state = join(root, opts.stateDir ?? '.stub');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(state, { recursive: true });
  if (opts.plan !== null) put(join(root, 'docs', 'plans', `${opts.plan ?? 'demo'}.md`), `# ${opts.plan ?? 'demo'}\n`);
  writeFileSync(join(state, 'done'), '');
  for (const [name, text] of Object.entries(opts.state ?? {})) writeFileSync(join(state, name), text);
  const paths = { root, scripts, state };
  const bodies = typeof opts.scripts === 'function' ? opts.scripts(paths) : (opts.scripts ?? {});
  for (const [name, body] of Object.entries(bodies)) put(join(scripts, name), body, 0o755);
  return {
    ...paths,
    markDone: (phase) => writeFileSync(join(state, 'done'), `${readFileSync(join(state, 'done'), 'utf8')}${phase}\n`),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** A stub `phase-lock.sh` that holds nothing — the one most runner tests write. */
export const FREE_LOCK_SH = `#!/usr/bin/env bash
[ "\${2:-}" = "status" ] && echo "phase \${3:-?}: free"
exit 0
`;

/** A stub `validate.sh` that passes. */
export const VALIDATE_OK_SH = '#!/usr/bin/env bash\necho "VALIDATE OK"\n';
