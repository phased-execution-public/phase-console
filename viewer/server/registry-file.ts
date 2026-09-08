/**
 * Version tolerance for the two on-disk registries — accounts and MCP servers.
 *
 * Both files are `{ version: 1, … }` and both used to be read with an exact
 * `parsed.version === 1`, then rewritten unconditionally at `version: 1` by the
 * next `persist()`. Those two facts together are a data-loss bug with a fuse in
 * it, and the fuse is our own next release:
 *
 *   1. A future build writes `version: 2` — a new field, a renamed one.
 *   2. The operator runs an older console against the same state directory: a
 *      Release tarball unpacked somewhere, a `git bisect`, a second clone beside the plugin,
 *      a rollback after a bad upgrade. All four are ordinary.
 *   3. The old reader does not recognise `version: 2`, so it degrades to
 *      "unreadable" — which for these registries means EMPTY, silently, with no
 *      warning louder than a debug line.
 *   4. The operator adds one account, or toggles one server. `persist()` writes
 *      the whole in-memory list back. The in-memory list is empty.
 *
 * Every registered account and every MCP server is gone, along with the
 * `secretRefs` that were the only remaining pointers to their keychain items —
 * which is how a credential becomes unreachable garbage rather than a secret
 * anybody can delete (see `McpCredentials.deleteAll`).
 *
 * Two rules close it, and neither needs to know what a future version means:
 *
 *  - **Read forward.** `version >= ours` is accepted and the rows are filtered
 *    on their own shape, which is what the readers already do. A version bump
 *    that adds a field is invisible to an old reader; one that breaks a row
 *    drops that row and keeps the rest. Refusing to read is the only outcome
 *    that guarantees loss.
 *  - **Never overwrite the future in place.** A file whose version is newer
 *    than this build's is copied aside before the rewrite, so the downgrade
 *    costs a rename rather than the registry.
 */

import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { log } from './log.ts';

/**
 * Is this parsed registry one we may read?
 *
 * `undefined`/absent version reads as version 1: the first shipped files were
 * written with the key, but a hand-edited one may not have it, and treating
 * that as unreadable would throw away a real registry over a missing default.
 */
export function versionOk(parsed: { version?: unknown } | null | undefined, ours: number): boolean {
  if (!parsed || typeof parsed !== 'object') return false;
  const raw = (parsed as { version?: unknown }).version;
  if (raw === undefined) return true;
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= ours;
}

/**
 * Copy `file` aside when it was written by a NEWER build than this one.
 *
 * Called immediately before a rewrite. Best effort in both directions: a file
 * that does not exist, cannot be parsed, or carries no version is this build's
 * own business and is overwritten as always; a backup that cannot be taken is
 * logged and the write proceeds, because refusing to persist would strand the
 * operator's change with nowhere to put it.
 *
 * One backup per (file, version) — the name is deterministic, so a downgraded
 * console that writes fifty times leaves one file, not fifty.
 */
export function backupIfNewer(file: string, what: string, ours = 1): void {
  let version: unknown;
  try {
    version = (JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown })?.version;
  } catch {
    return;   // absent, or not ours to preserve
  }
  if (typeof version !== 'number' || !Number.isFinite(version) || version <= ours) return;
  const backup = join(dirname(file), `${file.split('/').pop()}.v${version}.bak`);
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    copyFileSync(file, backup);
    log.warn(`${what}.downgrade`, {
      version,
      ours,
      backup,
      note: 'a newer registry is being rewritten by an older console — the original was copied aside',
    });
  } catch (error) {
    log.warn(`${what}.backup-failed`, { version, error: (error as Error).message });
  }
}
