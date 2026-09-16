/**
 * Carrying a session's transcript from one account's config dir to another's.
 *
 * A Claude session transcript is an account-agnostic local file at
 * `<config dir>/projects/<escaped-cwd>/<session-id>.jsonl`. Resuming it under
 * a different credential works — the CLI reads the file, the new account pays
 * for the turns — but only if the file exists in the config dir the resumed
 * process is looking at. Token accounts and the machine login share the
 * default dir, so their hand-offs are free; a PROFILE keeps its own dir, and
 * this is the copy that makes `--resume` find the conversation there.
 *
 * The escaped-cwd directory name is deliberately never re-derived: every
 * runner spawn uses the same cwd (the run's root), so the source file is
 * FOUND by its session id — a scan over `projects/*` — and its parent's
 * basename is reused verbatim on the target side. Re-implementing the CLI's
 * escaping is how this breaks the day that escaping changes.
 *
 * **The layout is the CLI's, and the CLI documents it nowhere** (the audit's
 * chapter 09 row 58: the relocation is undocumented and the entry format
 * "internal to Claude Code and changes between versions"). So the contract is
 * pinned rather than assumed (ACT-12): `assertTranscriptLayout` reads the
 * shape at startup and says whether it is the one this file understands, every
 * port records the CLI version it was made under, and a port reports `ported`
 * only when bytes actually moved — `findable` is the separate answer a resume
 * needs. The two used to be one boolean, and a `default → token` "port" (one
 * directory, two ids) journalled `ported: true` having copied nothing.
 *
 * Failure is an answer, not an error: the caller starts a fresh session and
 * the boot prompt plus the failure context carry the continuation. Losing a
 * transcript costs re-reading; guessing wrong about one would cost the phase.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { log } from '../log.ts';
import { realExec, type Exec } from './credentials.ts';

/** What a port did, and what a resume may rely on. */
export type PortResult = {
  /** The resumed session WILL find its transcript in the paying account's config dir. */
  findable: boolean;
  /** Bytes moved by this call — never true for a same-directory or already-there answer. */
  ported: boolean;
  why: 'copied' | 'nothing to carry' | 'already there' | 'not found' | 'copy failed';
  /** The CLI version the port was made under, when the caller knew it — the layout is that version's. */
  cliVersion?: string;
};

/** `<config dir>/projects/<escaped-cwd>/<sid>.jsonl`, found by id — or null. */
export function findTranscript(configDir: string, sessionId: string): string | null {
  if (!/^[0-9a-f-]{8,64}$/i.test(sessionId)) return null;
  const projects = join(configDir, 'projects');
  let dirs: string[];
  try {
    dirs = readdirSync(projects, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(projects, entry.name));
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const candidate = join(dir, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Copy the transcript into the target config dir. `findable` when the resumed
 * session will find its conversation there — whether because this call copied
 * it, because both accounts read one directory, or because it was already
 * there; `ported` only for the first.
 */
export function portTranscript(
  sessionId: string, fromDir: string, toDir: string, opts: { cliVersion?: string } = {},
): PortResult {
  const version = opts.cliVersion ? { cliVersion: opts.cliVersion } : {};
  // Same config dir — the machine login and a token account, say. There is
  // nothing to carry and nothing was: `findable` is what the resume needs,
  // `ported: false` is what the journal must say (ACT-12).
  if (fromDir === toDir) return { findable: true, ported: false, why: 'nothing to carry', ...version };
  const source = findTranscript(fromDir, sessionId);
  if (!source) {
    // Already where it is going counts as findable: a run switched A→B→A finds
    // the file it left, and answering false here would discard a good resume.
    if (findTranscript(toDir, sessionId)) return { findable: true, ported: false, why: 'already there', ...version };
    log.info('accounts.transcript.not-found', { sessionId, fromDir: basename(fromDir) });
    return { findable: false, ported: false, why: 'not found', ...version };
  }
  try {
    const targetDir = join(toDir, 'projects', basename(dirname(source)));
    mkdirSync(targetDir, { recursive: true });
    copyFileSync(source, join(targetDir, `${sessionId}.jsonl`));
  } catch (error) {
    log.warn('accounts.transcript.copy-failed', { sessionId, error: (error as Error).message });
    return { findable: false, ported: false, why: 'copy failed', ...version };
  }

  // The CLI's `todos/` sidecar used to be copied across with the conversation.
  // It is not any more: the CLI stopped writing it when it stopped provisioning
  // the task tools, so the copy walked a directory that is never there — and
  // the phase's task list now lives in `PhaseRecord.tasks`, which belongs to
  // the run rather than to whichever account's config dir the session happened
  // to be recorded in, and therefore survives the port without being carried.

  log.info('accounts.transcript.ported', { sessionId, to: basename(toDir), cliVersion: opts.cliVersion ?? null });
  return { findable: true, ported: true, why: 'copied', ...version };
}

/** What `assertTranscriptLayout` found. */
export type TranscriptLayout = {
  /** The shape this file understands — or nothing to check yet. */
  ok: boolean;
  /** Whether `<configDir>/projects` exists at all (a fresh machine has none — that is not a mismatch). */
  projects: boolean;
  /** How many escaped-cwd directories were seen, and how many held a `.jsonl`. */
  dirs: number;
  withTranscripts: number;
  detail: string;
};

/**
 * Does this config dir hold transcripts the way `findTranscript` expects —
 * `projects/<escaped-cwd>/<uuid>.jsonl`? Read once at startup and logged
 * (`accounts.transcript-layout`), so a CLI release that moves the files is
 * noticed on the day rather than at the first switch that finds nothing. A
 * missing `projects/` is not a mismatch (no session has run from here yet); a
 * `projects` that is not a directory, or directories full of files none of
 * which is a `.jsonl`, is.
 */
export function assertTranscriptLayout(configDir: string): TranscriptLayout {
  const projects = join(configDir, 'projects');
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(projects);
  } catch {
    return { ok: true, projects: false, dirs: 0, withTranscripts: 0, detail: 'no projects/ directory yet — nothing to check' };
  }
  if (!stat.isDirectory()) {
    return { ok: false, projects: true, dirs: 0, withTranscripts: 0, detail: 'projects is not a directory — the CLI has moved its transcripts' };
  }
  let dirs = 0;
  let withTranscripts = 0;
  let filesSeen = 0;
  try {
    for (const entry of readdirSync(projects, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      dirs += 1;
      let files: string[] = [];
      try { files = readdirSync(join(projects, entry.name)); } catch { continue; }
      filesSeen += files.length;
      if (files.some((name) => /^[0-9a-f-]{8,64}\.jsonl$/i.test(name))) withTranscripts += 1;
    }
  } catch (error) {
    return { ok: false, projects: true, dirs, withTranscripts, detail: `could not read projects/: ${(error as Error).message}` };
  }
  const ok = filesSeen === 0 || withTranscripts > 0;
  return {
    ok, projects: true, dirs, withTranscripts,
    detail: ok
      ? `${withTranscripts} of ${dirs} project directories hold a <uuid>.jsonl transcript`
      : `${dirs} project directories, ${filesSeen} files, none a <uuid>.jsonl — the CLI has changed its transcript layout`,
  };
}

let cliVersionMemo: Promise<string | undefined> | null = null;

/**
 * The installed CLI's version, asked once per process — `claude --version`,
 * through the same injectable `Exec` the credential layer uses. A console that
 * cannot run it answers undefined and the port is recorded without a version,
 * which is honest; a fabricated one would be the thing this exists to prevent.
 */
export function cliVersion(exec: Exec = realExec): Promise<string | undefined> {
  cliVersionMemo ??= exec('claude', ['--version'])
    .then(({ stdout }) => /\d+\.\d+\.\d+/.exec(stdout)?.[0])
    .catch(() => undefined);
  return cliVersionMemo;
}

/** Tests only: forget the memoised version so the next ask runs the exec again. */
export function forgetCliVersion(): void {
  cliVersionMemo = null;
}
