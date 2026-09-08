/**
 * Registry ids → the `--mcp-config` document the CLI reads.
 *
 * This is the only place a secret is joined to a server definition, and the
 * only place that writes a file containing one. Both facts are load-bearing:
 *
 *  - **0600, under the instance state dir, one per run AND PHASE**, exactly as
 *    `writeSettingsFile` does for the per-run permission settings. The
 *    `chmodSync` after the write is not redundant — `writeFileSync`'s `mode`
 *    applies only when it creates the file, so a rewrite of an existing path
 *    would otherwise keep whatever mode it had. And nothing leaves one behind:
 *    `pruneMcpConfigs` / `dropMcpConfigsFor` are swept from the runner's own
 *    loop-end and from the service's boot, because a file holding a live bearer
 *    token in plaintext must not outlive the run that needed it.
 *  - **The config is passed with `--strict-mcp-config`**, so the set this file
 *    resolves is the ONLY set the session gets. Without it the CLI would union
 *    in whatever `~/.claude.json` and the project's `.mcp.json` happen to hold,
 *    and an unattended run would be talking to servers nobody chose for it.
 *    Determinism here is a safety property, not a tidiness one.
 *
 * `${VAR}` values are passed through untouched rather than expanded. The CLI
 * expands them itself, in the child's environment, with `${VAR:-default}`
 * support — re-implementing that here would be a second, subtly different
 * expander, and would put the resolved value in a file when the whole point of
 * writing `${VAR}` was to keep it out of one.
 */

import { chmodSync, mkdirSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import { log } from '../log.ts';
import type { McpCredentials } from './credentials.ts';
import { MCP_CONFIG_DIR, type McpServerMeta, type McpTransport } from './store.ts';

/** One entry of the `mcpServers` object, as the CLI's schema defines it. */
type McpConfigEntry = {
  type: McpTransport;
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
  alwaysLoad?: boolean;
  timeout?: number;
};

export type McpConfigDoc = { mcpServers: Record<string, McpConfigEntry> };

/**
 * Build the document for a set of servers, splicing in whatever secrets they
 * declared. A ref with no stored secret is left out rather than written as an
 * empty header: an absent `Authorization` fails at connect with a 401 the
 * console can classify as "needs authentication", while an empty one is a
 * malformed request the server reports as something else entirely.
 */
export async function buildMcpConfig(
  servers: McpServerMeta[],
  credentials: McpCredentials,
): Promise<McpConfigDoc> {
  const mcpServers: Record<string, McpConfigEntry> = {};
  for (const meta of servers) {
    const headers: Record<string, string> = { ...(meta.headers ?? {}) };
    const env: Record<string, string> = { ...(meta.env ?? {}) };
    for (const ref of meta.secretRefs ?? []) {
      const secret = await credentials.read(meta.id, ref);
      if (!secret) continue;
      const value = ref.template ? ref.template.replace('{}', secret) : secret;
      if (ref.kind === 'header') headers[ref.name] = value;
      else env[ref.name] = value;
    }
    const entry: McpConfigEntry = { type: meta.transport };
    if (meta.transport === 'stdio') {
      entry.command = meta.command ?? '';
      if (meta.args?.length) entry.args = [...meta.args];
      if (Object.keys(env).length) entry.env = env;
    } else {
      entry.url = meta.url ?? '';
      if (Object.keys(headers).length) entry.headers = headers;
    }
    if (meta.alwaysLoad) entry.alwaysLoad = true;
    // Below 1000 the CLI ignores it and falls through to MCP_TOOL_TIMEOUT, so a
    // smaller number would read as configured while doing nothing.
    if (meta.timeoutMs && meta.timeoutMs >= 1000) entry.timeout = meta.timeoutMs;
    mcpServers[meta.id] = entry;
  }
  return { mcpServers };
}

/**
 * Write the document for one PHASE of one run and return its path, or null when
 * the set is empty — an empty `mcpServers` with `--strict-mcp-config` is a real
 * instruction ("no servers at all"), but the caller expresses that by passing
 * no flag, which is cheaper and reads the same to the CLI.
 *
 * **The phase is part of the key, and that is the whole point.** The document
 * is built per phase — a phase's servers are the union of the plan's, the
 * run's and its own, and `mcpOff` drops only the run's — but the file was keyed
 * by run alone. A run driving two lanes at once therefore had both of them
 * writing one path: whichever boarded second overwrote the first's document,
 * and since `--strict-mcp-config` makes the file the ONLY set the session gets,
 * a phase could spawn holding another phase's servers, or none of its own.
 *
 * What the key does NOT need is an attempt counter. The rewrite is per attempt
 * already, the content is a pure function of (phase, registry, secrets), and a
 * retry wants the fresh document under the same name so the previous one does
 * not survive it.
 */
export function writeMcpConfigFile(runId: string, phase: number, doc: McpConfigDoc): string | null {
  if (!Object.keys(doc.mcpServers).length) return null;
  return writeConfigDoc(mcpConfigName(runId, phase), doc);
}

/** The basename this run+phase's resolved config lives under. */
export function mcpConfigName(runId: string, phase: number): string {
  return `run-${runId}-p${phase}.json`;
}

/**
 * A config for the health probe: same 0600 discipline, its own throwaway name.
 *
 * The probe's set is not a run's set — it is whatever somebody asked about —
 * so it must never land on a run's path and be pruned, or prune one. The random
 * suffix also keeps two concurrent probes from sharing a file; unlike the run
 * path there is no natural key to give them. The caller unlinks it.
 */
export function writeProbeConfigFile(doc: McpConfigDoc): string {
  return writeConfigDoc(`probe-${randomBytes(8).toString('hex')}.json`, doc)!;
}

function writeConfigDoc(name: string, doc: McpConfigDoc): string {
  mkdirSync(MCP_CONFIG_DIR, { recursive: true, mode: 0o700 });
  const path = join(MCP_CONFIG_DIR, name);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, path);
  // `mode` on writeFileSync only applies on create; a rewrite would keep the old one.
  chmodSync(path, 0o600);
  return path;
}

/**
 * Delete every resolved config that does not belong to a run in `keep`.
 *
 * These files are the only place in the system where a bearer token sits in
 * plaintext on disk under a name anybody can guess, and nothing deleted them —
 * not the run ending, not the server being removed from the registry, not the
 * console restarting. A machine that had run the console for a month held one
 * file per phase per run, each with live credentials in it, indefinitely.
 *
 * Two callers, which together mean no file outlives its run: the runner sweeps
 * a run's own files when its drive loop ends, and the service sweeps everything
 * unclaimed at boot (which is what catches the runs a crash never closed).
 *
 * Probe files are swept too — they are unlinked by the probe itself, so any
 * left here is one whose console died mid-probe, and it can only be debris.
 *
 * Best effort by design: a file we cannot delete is logged, never thrown. This
 * runs on the boot path and inside a `finally`, and neither is a place to fail
 * a run over a permissions problem on a temporary file.
 */
export function pruneMcpConfigs(keep: Iterable<string>): string[] {
  return sweepConfigs((name) => {
    if (name.startsWith('probe-')) return true;
    return ![...keep].some((runId) => ownedBy(name, runId));
  });
}

/**
 * Does this file belong to that run?
 *
 * Matched against the WHOLE name — `run-<id>-p<n>.json` — rather than by
 * prefix. Run ids are `randomUUID().slice(0, 8)`, so today no id can be a
 * prefix of another and the two are equivalent; but "all ids are the same
 * length" is an invariant living in a different file, and if it ever stopped
 * holding a prefix test would let `dropMcpConfigsFor('abc')` delete run
 * `abc-def`'s configs — one lane sweeping another's out from under it, which is
 * the exact failure mcp-1 was about. Costing nothing to be exact, be exact.
 */
function ownedBy(name: string, runId: string): boolean {
  return new RegExp(`^run-${runId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-p\\d+\\.json$`).test(name);
}

/**
 * Drop exactly one run's resolved configs.
 *
 * The runner's own sweep, and deliberately not `pruneMcpConfigs(everyOtherRun)`:
 * a Runner drives ONE run and has no trustworthy view of which others are live,
 * so asking it to name the keep-set would make one lane's cleanup able to
 * delete another lane's config. Naming only its own can never do that, and the
 * boot sweep is what eventually collects the runs a crash left behind.
 */
export function dropMcpConfigsFor(runId: string): string[] {
  return sweepConfigs((name) => ownedBy(name, runId));
}

function sweepConfigs(shouldDelete: (name: string) => boolean): string[] {
  let names: string[];
  try {
    names = readdirSync(MCP_CONFIG_DIR);
  } catch {
    return [];   // never created, or already gone
  }
  const removed: string[] = [];
  for (const name of names) {
    if (!name.startsWith('run-') && !name.startsWith('probe-')) continue;
    if (!shouldDelete(name)) continue;
    try {
      unlinkSync(join(MCP_CONFIG_DIR, name));
      removed.push(name);
    } catch (error) {
      log.warn('mcp.config.prune-failed', { file: name, error: (error as Error).message });
    }
  }
  return removed;
}

/**
 * What a person should see instead of the file: the same document with every
 * secret replaced. Used by the UI's "what will this run connect to" preview and
 * by anything that logs a config, so neither has to remember to redact.
 */
export function redactConfig(doc: McpConfigDoc): McpConfigDoc {
  const out: Record<string, McpConfigEntry> = {};
  for (const [id, entry] of Object.entries(doc.mcpServers)) {
    const copy: McpConfigEntry = { ...entry };
    if (copy.headers) copy.headers = redactValues(copy.headers);
    if (copy.env) copy.env = redactValues(copy.env);
    out[id] = copy;
  }
  return { mcpServers: out };
}

/**
 * A `${VAR}` reference is not a secret and stays legible — seeing which
 * variable a server wants is most of what makes a misconfiguration findable.
 * Everything else becomes a fixed mask, with no length hint.
 */
function redactValues(values: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    out[key] = /^\$\{[^}]+\}$/.test(value.trim()) ? value : '••••••';
  }
  return out;
}
