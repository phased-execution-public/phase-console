/**
 * The credential probes (phase 11, ZTD-4): is the credential a plan names
 * HELD on this machine — a yes or a no by id, never a value.
 *
 * A plan's `**Credentials:**` line (and a phase's `- **Credentials:**`
 * bullet) names ids; this registry knows how to ask about each KIND of id and
 * answers `ok` (held), `fail` (absent) or `skip` (no probe for that id here —
 * a keychain item off macOS, an id nobody taught it). Every answer carries a
 * reason a stranger can act on and, on purpose, nothing else: the probe that
 * checks a token's presence must not become the thing that prints it.
 *
 *   gh                 `gh auth status` exits 0 (the GitHub CLI's own word)
 *   claude, claude-login  the machine `claude` login (`runner/auth.ts`, cached)
 *   env:NAME           the variable is set and non-empty in this process
 *   keychain:SERVICE   `security find-generic-password -s SERVICE` exits 0 (darwin)
 *   file:PATH          the path exists (`~` expands)
 *
 * The prelude asks for the run-level union before a run starts; the runner
 * asks for a phase's own list before it spawns (`phase.credential-preflight`);
 * `phase-console doctor` asks for `gh` and `claude` with no plan at all. All
 * three read this one registry, memoised for `PROBE_CACHE_MS` so a form
 * polling the prelude does not fork `gh` on every keystroke.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import type { ProbeStatus } from '../shared/ops-vocab.js';

/** One credential's verdict — the id, the word, the reason. Never a value. */
export type CredentialVerdict = { id: string; status: ProbeStatus; reason: string };

/** How long a probe's answer stands before it is asked again. */
export const PROBE_CACHE_MS = 60_000;

/** The one-word ids the registry knows besides the prefixed kinds. */
export const CLI_LOGIN_IDS = Object.freeze(['claude', 'claude-login']);

/** How the probes reach the world — swapped by tests and by `doctor` off-line. */
export type ProbeDeps = {
  /** Run a command; resolve `code` (null when it could not start). */
  exec?: (file: string, args: string[]) => Promise<{ code: number | null; stderr: string }>;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  /** The `claude` login probe — `runner/auth.ts` by default. */
  claudeLogin?: (cwd: string) => Promise<{ loggedIn: boolean; detail?: string }>;
  cwd?: string;
  now?: () => number;
};

const PROBE_TIMEOUT_MS = 10_000;

/** `execFile` with a timeout the runtime enforces — no `.kill(` of our own. */
export function defaultExec(file: string, args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { timeout: PROBE_TIMEOUT_MS, windowsHide: true }, (error, _stdout, stderr) => {
        if (!error) { resolve({ code: 0, stderr: String(stderr ?? '') }); return; }
        const code = typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : null;
        resolve({ code, stderr: String(stderr ?? (error as Error).message ?? '') });
      });
    } catch (error) {
      resolve({ code: null, stderr: String((error as Error)?.message ?? error) });
    }
  });
}

function expandHome(path: string, home: string): string {
  if (path === '~') return home;
  if (path.startsWith('~/')) return join(home, path.slice(2));
  return path;
}

/** Is `id` something the registry can answer, whatever the answer? */
export function knownCredentialId(id: string): boolean {
  return id === 'gh' || CLI_LOGIN_IDS.includes(id) || /^(env|keychain|file):.+/.test(id);
}

/**
 * One id, one verdict. Uncached — `credentialsHeld` is the memoised door.
 */
export async function probeCredential(id: string, deps: ProbeDeps = {}): Promise<CredentialVerdict> {
  const exec = deps.exec ?? defaultExec;
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const home = deps.home ?? homedir();
  const cwd = deps.cwd ?? process.cwd();
  if (id === 'gh') {
    const { code, stderr } = await exec('gh', ['auth', 'status']);
    if (code === 0) return { id, status: 'ok', reason: 'gh auth status: signed in' };
    if (code === null) return { id, status: 'skip', reason: 'the gh CLI is not on PATH for this process' };
    return { id, status: 'fail', reason: `gh auth status exited ${code}${firstLine(stderr) ? ` — ${firstLine(stderr)}` : ''}` };
  }
  if (CLI_LOGIN_IDS.includes(id)) {
    // The console's own auth probe, loaded on first use rather than at import:
    // `runner/auth.ts` reaches `log.ts` and so `config.ts`, whose instance
    // identity resolves at module load — and `phase-console doctor` imports
    // this file from a process that is not a console. A leaf at load, the
    // console's probe at use.
    const probe = deps.claudeLogin
      ?? (async (dir: string) => (await import('./runner/auth.ts')).checkAuthFor(dir, null, 'default'));
    try {
      const status = await probe(cwd);
      return status.loggedIn
        ? { id, status: 'ok', reason: 'claude auth status: signed in' }
        : { id, status: 'fail', reason: `the machine claude login is signed out${status.detail ? ` — ${status.detail}` : ''}` };
    } catch (error) {
      return { id, status: 'skip', reason: `claude auth status could not run — ${String((error as Error)?.message ?? error)}` };
    }
  }
  const env_ = /^env:(.+)$/.exec(id);
  if (env_) {
    const name = env_[1];
    const value = env[name];
    return value !== undefined && value !== ''
      ? { id, status: 'ok', reason: `$${name} is set` }
      : { id, status: 'fail', reason: `$${name} is not set in the console's environment` };
  }
  const keychain = /^keychain:(.+)$/.exec(id);
  if (keychain) {
    if (platform !== 'darwin') return { id, status: 'skip', reason: 'keychain items can only be probed on macOS' };
    const { code } = await exec('security', ['find-generic-password', '-s', keychain[1]]);
    if (code === 0) return { id, status: 'ok', reason: `keychain item ${keychain[1]} exists` };
    if (code === null) return { id, status: 'skip', reason: 'the security tool could not run' };
    return { id, status: 'fail', reason: `no keychain item named ${keychain[1]}` };
  }
  const file = /^file:(.+)$/.exec(id);
  if (file) {
    const path = expandHome(file[1], home);
    const shown = isAbsolute(path) ? path.replace(home, '~') : path;
    return existsSync(path)
      ? { id, status: 'ok', reason: `${shown} exists` }
      : { id, status: 'fail', reason: `${shown} does not exist` };
  }
  return { id, status: 'skip', reason: 'no probe for this credential id (known kinds: gh, claude, env:NAME, keychain:SERVICE, file:PATH)' };
}

function firstLine(text: string): string {
  return (text ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
}

const cache = new Map<string, { at: number; verdict: CredentialVerdict }>();

/** Forget every cached answer — tests, and a Settings ▸ re-check button. */
export function forgetCredentialProbes(): void {
  cache.clear();
}

/**
 * The verdicts for a list of ids, memoised per id for `PROBE_CACHE_MS`.
 * Order preserved; a duplicated id answers once.
 */
export async function credentialsHeld(ids: readonly string[], deps: ProbeDeps = {}): Promise<CredentialVerdict[]> {
  const now = deps.now ?? Date.now;
  const out: CredentialVerdict[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const hit = cache.get(id);
    if (hit && now() - hit.at < PROBE_CACHE_MS) { out.push(hit.verdict); continue; }
    const verdict = await probeCredential(id, deps);
    cache.set(id, { at: now(), verdict });
    out.push(verdict);
  }
  return out;
}

/** The ids currently known to be held — what `PE_CREDENTIALS` carries to the engine's F15 lint. */
export function heldIdsCached(): string[] {
  return [...cache.entries()].filter(([, v]) => v.verdict.status === 'ok').map(([id]) => id);
}
