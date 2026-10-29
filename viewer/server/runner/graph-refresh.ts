/**
 * The landing refreshes a repository's knowledge graph (measured-console phase
 * 11, the audit's D6): after a lane lands, each repository it reached that
 * keeps a graph is updated with `<tool> update .` — the tool's own
 * re-extraction, which calls no model — so the boot prompt's graph directive,
 * emitted only while the graph is newer than the last landing
 * (`skills.ts` `graphFreshness`), keeps being emitted for a repository that
 * keeps one.
 *
 * WHICH tool is the operator's word, never this code's: the console's
 * `graphTool` setting names a command that writes `<tool>-out/graph.json` in a
 * repository and updates it with `<tool> update <path>`. Empty — the shipped
 * default — switches the directive and the refresh off. The repository names
 * no particular tool (`.github/scripts/scrub.sh`), and neither does anything
 * it ships.
 *
 * Never red: the tool absent from PATH, a repository with no graph, a failure
 * and a timeout are each a journal line, and the landing stands. Bounded by
 * `GRAPH_UPDATE_TIMEOUT_MS`. A repository with no graph directory is never
 * given one — building a graph from nothing is a person's choice, and its
 * cache carries the machine's paths.
 */

import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/** How long one repository's update may take before it is cut. */
export const GRAPH_UPDATE_TIMEOUT_MS = 120_000;
/** What `graphTool` may hold: a bare command name, never a path or a word with a space. */
export const GRAPH_TOOL_RE = /^[A-Za-z0-9][\w.-]{0,40}$/;

/** The tool's name as `graphTool` holds it, or '' — the setting off. */
export function graphToolOf(value: unknown): string {
  return typeof value === 'string' && GRAPH_TOOL_RE.test(value.trim()) ? value.trim() : '';
}

/** The directory a repository's graph lives in: `<tool>-out`. */
export function graphDirFor(tool: string): string {
  return `${tool}-out`;
}

export type GraphRefresh = {
  repo: string;
  /** `updated` · `failed` · `timed-out` · `no-graph` · `no-tool`. */
  result: 'updated' | 'failed' | 'timed-out' | 'no-graph' | 'no-tool';
  ms: number;
  detail?: string;
};

/** `tool` on this PATH, or null. */
export function toolOnPath(tool: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!graphToolOf(tool)) return null;
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const bin = join(dir, tool);
    try { accessSync(bin, constants.X_OK); return bin; } catch { /* next */ }
  }
  return null;
}

type Run = (bin: string, args: string[], opts: { cwd: string; timeout: number; env?: NodeJS.ProcessEnv }) =>
  Promise<{ code: number | null; timedOut: boolean; stderr: string }>;

const runFile: Run = (bin, args, opts) => new Promise((resolve) => {
  execFile(bin, args, { cwd: opts.cwd, timeout: opts.timeout, env: opts.env ?? process.env, maxBuffer: 4 * 1024 * 1024 }, (error, _stdout, stderr) => {
    const err = error as (NodeJS.ErrnoException & { killed?: boolean; signal?: string; code?: unknown }) | null;
    resolve({
      code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
      timedOut: Boolean(err?.killed && err.signal),
      stderr: String(stderr ?? ''),
    });
  });
});

/** Update each repository's graph in turn; one answer per repository, never a throw. Nothing at all with no tool named. */
export async function refreshGraphs(
  repos: readonly string[],
  opts: { tool: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; run?: Run; now?: () => number },
): Promise<GraphRefresh[]> {
  const tool = graphToolOf(opts.tool);
  if (!tool) return [];
  const now = opts.now ?? Date.now;
  const out: GraphRefresh[] = [];
  const unique = [...new Set(repos)];
  const withGraph = unique.filter((repo) => existsSync(join(repo, graphDirFor(tool))));
  for (const repo of unique) {
    if (!withGraph.includes(repo)) out.push({ repo, result: 'no-graph', ms: 0 });
  }
  if (!withGraph.length) return out;
  const bin = toolOnPath(tool, opts.env);
  if (!bin) return [...out, ...withGraph.map((repo) => ({ repo, result: 'no-tool' as const, ms: 0 }))];
  for (const repo of withGraph) {
    const started = now();
    try {
      const ran = await (opts.run ?? runFile)(bin, ['update', '.'], {
        cwd: repo, timeout: opts.timeoutMs ?? GRAPH_UPDATE_TIMEOUT_MS, ...(opts.env ? { env: opts.env } : {}),
      });
      const ms = now() - started;
      if (ran.timedOut) out.push({ repo, result: 'timed-out', ms });
      else if (ran.code === 0) out.push({ repo, result: 'updated', ms });
      else out.push({ repo, result: 'failed', ms, detail: ran.stderr.trim().split('\n').pop()?.slice(0, 200) ?? `exit ${ran.code}` });
    } catch (error) {
      out.push({ repo, result: 'failed', ms: now() - started, detail: String((error as Error)?.message ?? error).slice(0, 200) });
    }
  }
  return out;
}
