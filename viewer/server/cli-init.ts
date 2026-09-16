/**
 * The newest `system/init.claude_code_version` a session on this console
 * reported — the one fact the relay's CLI floor is read from (zero-touch-console
 * phase 14, QRL-5, AC-13; `runner/session-record.ts` `relayArmingFor`).
 *
 * Why a store at all: the relay has to decide before a session starts whether
 * that session gets the permission host and the `PermissionRequest` hook, and
 * the only field allowed to answer — `claude_code_version` on `system/init` —
 * arrives after it starts. So every session's init is remembered here, and the
 * next spawn reads the newest. A console that has never seen one answers
 * nothing, and the relay refuses to arm on nothing.
 *
 * Persisted per instance, so a restart does not cost the first relay-on session
 * its relay — but a remembered version is believed only while the installed
 * binary is the one that reported it (`claude --version`, compared as a whole
 * string, never parsed into the floor): an upgrade or a downgrade between two
 * consoles must not arm on a version the binary no longer is. The version a
 * session of THIS process reported is always believed.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { INSTANCE_STATE_DIR } from './config.ts';
import { log } from './log.ts';

export type CliInit = {
  /** `system/init.claude_code_version`, verbatim. */
  version: string;
  at: string;
  /** What `claude --version` answered when this was recorded, when anything did. */
  binary?: string;
};

const DEFAULT_FILE = join(INSTANCE_STATE_DIR, 'cli-init.json');

/** The init this process saw, which needs no binary check. */
let seen: CliInit | null = null;

/** Remember what a session's `system/init` said. Never throws. */
export function noteCliInit(version: string, binary?: string, file = DEFAULT_FILE): void {
  if (!version) return;
  const next: CliInit = { version: version.slice(0, 40), at: new Date().toISOString(), ...(binary ? { binary } : {}) };
  seen = next;
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp.${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(next)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, file);
  } catch (error) {
    log.warn('cli-init.persist-failed', { file, error: String(error) });
  }
}

/**
 * The init version the relay may arm on: this process's own, else the
 * remembered one when the installed binary still answers what it answered
 * then (or cannot be asked). Null when nothing qualifies.
 */
export function initVersionFor(binaryNow: string | undefined, file = DEFAULT_FILE): string | null {
  if (seen) return seen.version;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<CliInit>;
    if (typeof parsed.version !== 'string' || !parsed.version) return null;
    if (binaryNow && parsed.binary && parsed.binary !== binaryNow) return null;
    return parsed.version;
  } catch {
    return null;
  }
}

/** Tests only: forget what this process saw. */
export function forgetCliInit(): void {
  seen = null;
}
