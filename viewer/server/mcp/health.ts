/**
 * Is this server actually reachable, and is it signed in?
 *
 * There is exactly one honest way to ask, and it is not `claude mcp list`: that
 * command answers for the servers configured in a config dir, in prose, with
 * status glyphs. What the console needs is the answer for a SPECIFIC set — the
 * set a phase is about to board with — in a form a program can act on.
 *
 * So the probe is a real session that never gets to think:
 *
 *   claude -p "ok" --max-turns 1 --output-format stream-json --verbose
 *          --strict-mcp-config --mcp-config <the set>
 *
 * `system/init` is emitted BEFORE the first model call and carries
 * `mcp_servers: [{name, status}]` plus `mcp_server_errors` for entries that
 * failed config validation. We read that first line and kill the child, so the
 * probe costs a process and a connect, not a turn.
 *
 * Two properties this buys that nothing else does:
 *
 *  - the statuses are the ones THAT session would have seen, including
 *    `needs-auth`, which is the whole point of parking before boarding;
 *  - `init.tools` lists every `mcp__<server>__<tool>` name, which is the
 *    rug-pull fingerprint and the `requiresUserInteraction` audit for free.
 *
 * The poller posture from `accounts/usage.ts` applies unchanged: single-flight,
 * cached, and a failure degrades to the last known answer with its age
 * attached. A probe that cannot run is never an error page — the runner's own
 * classifier still works with health unavailable.
 */

import { spawn } from 'node:child_process';
import { unlinkSync } from 'node:fs';

import { log } from '../log.ts';
import { killLadder, type LadderOptions } from '../runner/signals.ts';
import { writeProbeConfigFile, type McpConfigDoc } from './config.ts';
import { MCP_STATUSES } from '../../shared/ops-vocab.js';

/**
 * The probe's own name, in the vocabulary the locks and the session registry
 * already read (`kindOf`: `console/…` → `agent`). Until zero-touch-console
 * phase 7 the probe was spawned with the console's environment unmodified, so
 * `PE_OWNER` was empty, the presence hook filed it `foreign`, and 82 % of the
 * registry was the console talking to itself in the operator's name (SLF-2,
 * REG-6). `PHASE_CONSOLE_PROBE=1` rides beside it so the hook can say WHICH
 * console child this is: the registry keeps the record, flags it, keeps it
 * out of every operator-facing total and never weakly correlates it.
 */
export const PROBE_OWNER = 'console/mcp-probe';
export const PROBE_FLAG = 'PHASE_CONSOLE_PROBE';

/**
 * How long the probe gets to leave on SIGTERM before the group is SIGKILLed.
 *
 * The CLI runs its SessionEnd hook on SIGTERM — that is why the runner's own
 * ladder uses it — and the probe has no transcript to flush and one hook to
 * run, so three seconds is generous. The SIGKILL that follows is still
 * needed: an `npx -y …@latest` stdio shim swallows the TERM, and the leak
 * this used to be was exactly those shims outliving the CLI.
 */
export const PROBE_TERM_GRACE_MS = 3_000;

/** Statuses the CLI reports in `system/init`. Unknown values pass through. */
export type McpStatus = (typeof MCP_STATUSES)[number];

export type McpHealth = {
  id: string;
  status: McpStatus;
  /** Tool names this server advertised, without the `mcp__<id>__` prefix. */
  tools: string[];
  /** Why the CLI skipped this entry outright, when it did. */
  error?: { type: string; message: string };
};

export type McpProbe = {
  servers: McpHealth[];
  checkedAt: string;
  /** Set when the probe itself could not run — the servers list is then stale. */
  probeError?: string;
};

/** How long we wait for `system/init`. The CLI's own startup timeout is 30s. */
const PROBE_TIMEOUT_MS = 45_000;

export type ProbeOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  now?: () => Date;
  /** Injected in tests so no suite ever spawns a real CLI. */
  spawnFn?: typeof spawn;
  /** The ending's seams (`signals.ts` `LadderOptions`), for a test that proves the TERM-then-KILL order. */
  ladder?: Pick<LadderOptions, 'signal' | 'alive' | 'sleep' | 'killAfterMs'>;
  /** Called once the ending is done, with how it ended — a test's wait handle. */
  onEnded?: (how: string) => void;
};

/**
 * Probe one config document. Never rejects: a probe that cannot run answers
 * with `probeError` set and an empty list, because "I could not check" and
 * "they are down" are different facts and the caller must be able to tell them
 * apart before it parks somebody's run.
 */
export async function probeMcp(doc: McpConfigDoc, opts: ProbeOptions = {}): Promise<McpProbe> {
  const now = opts.now ?? (() => new Date());
  const ids = Object.keys(doc.mcpServers);
  if (!ids.length) return { servers: [], checkedAt: now().toISOString() };

  const spawnFn = opts.spawnFn ?? spawn;

  // `--mcp-config` takes a file OR a JSON string, and the string is the trap:
  // this document is the fully RESOLVED one, with every bearer token and API
  // key spliced in by `config.ts`. In argv it is readable by every process
  // running as this user — `ps`, `/proc/<pid>/cmdline` — and the set of such
  // processes very much includes the `npx -y <third-party>@latest` stdio
  // servers this probe is in the act of launching. A 0600 file under the
  // instance state dir is the same instruction with none of that, and it is
  // what the spawn path has always done for the identical reason.
  let configPath: string;
  try {
    configPath = writeProbeConfigFile(doc);
  } catch (error) {
    return { servers: [], checkedAt: now().toISOString(), probeError: (error as Error).message };
  }

  const argv = [
    '--print', 'ok',
    '--max-turns', '1',
    '--output-format', 'stream-json',
    '--verbose',
    // The set under test is the only set: without this the CLI would union in
    // the user's own servers and the answer would be about the wrong thing.
    '--strict-mcp-config',
    '--mcp-config', configPath,
  ];

  return new Promise<McpProbe>((resolve) => {
    let settled = false;
    let buffer = '';
    const finish = (probe: McpProbe) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killProbeTree(child, opts);
      // The CLI has read it by the time it reports `system/init`, and every
      // exit from this function passes through here, so the window in which a
      // resolved config exists on disk is the probe's own lifetime.
      try { unlinkSync(configPath); } catch { /* already gone */ }
      resolve(probe);
    };

    const timer = setTimeout(
      () => finish({ servers: [], checkedAt: now().toISOString(), probeError: 'timed out waiting for the CLI' }),
      opts.timeoutMs ?? PROBE_TIMEOUT_MS,
    );

    let child: ReturnType<typeof spawn>;
    try {
      child = spawnFn('claude', argv, {
        cwd: opts.cwd,
        // The probe names itself (SLF-2, REG-6): `PE_OWNER` is what the
        // presence hook posts as the session's owner, and the flag is what
        // tells the registry this is the console's own probe rather than one
        // of its agent sessions.
        env: { ...(opts.env ?? process.env), PE_OWNER: PROBE_OWNER, [PROBE_FLAG]: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        // The probe's whole job is to make the CLI start MCP servers, so it is
        // the one console child guaranteed to have descendants worth killing:
        // every stdio entry becomes an `npx`, and an `npx -y …@latest` is a
        // shim that spawns the real server under itself. Killing the CLI alone
        // left those running with no parent to notice — a probe on a five-server
        // set leaked five trees, on a clock, for the life of the console. A
        // group of its own is what makes `killProbeTree` able to address them.
        detached: true,
      });
    } catch (error) {
      clearTimeout(timer);
      try { unlinkSync(configPath); } catch { /* never written */ }
      resolve({ servers: [], checkedAt: now().toISOString(), probeError: (error as Error).message });
      return;
    }

    child.on('error', (error: Error) => {
      finish({ servers: [], checkedAt: now().toISOString(), probeError: error.message });
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      // `system/init` is the first line unless a SessionStart hook or a plugin
      // install got there first, so scan rather than assume.
      let cut = buffer.indexOf('\n');
      while (cut >= 0) {
        const line = buffer.slice(0, cut).trim();
        buffer = buffer.slice(cut + 1);
        const parsed = parseInit(line);
        if (parsed) {
          const servers = readInit(parsed, ids);
          finish(servers
            ? { servers, checkedAt: now().toISOString() }
            : {
                servers: [],
                checkedAt: now().toISOString(),
                probeError: 'the CLI reported startup without an mcp_servers list',
              });
          return;
        }
        cut = buffer.indexOf('\n');
      }
    });

    child.on('close', (code) => {
      // Closed without ever emitting init: something stopped the CLI before it
      // got to its own startup, which is a probe failure, not a server verdict.
      finish({
        servers: [],
        checkedAt: now().toISOString(),
        probeError: `the CLI exited (${code ?? 'signal'}) before reporting server status`,
      });
    });
  });
}

/**
 * End the probe and everything it started — through `signals.ts`, like every
 * other console child.
 *
 * It used to be SIGKILL directly, on the reasoning that a probe has no
 * transcript to flush. True, but a SIGKILLed CLI runs no SessionEnd hook
 * either, so the registry learned of every probe's death by pid probe and
 * 168 records a day sat `ended: process-gone` (SLF-2 iii). The ladder here is
 * the runner's with the interrupt rung off — there is no turn to close —
 * SIGCONT, then SIGTERM to the GROUP (`detached: true` made one: the CLI, its
 * `npx` shims and the servers under them), a short grace for the hook, then
 * the SIGKILL the shims need. Never awaited: the probe's answer is already
 * in hand, and the ending is bookkeeping.
 *
 * The no-group fallback (a spawn seam that gave us no pid) is the one
 * `.kill(` this file keeps, and `test/invariants.test.ts` names it.
 */
function killProbeTree(child: ReturnType<typeof spawn>, opts: ProbeOptions): void {
  if (typeof child.pid === 'number' && child.pid > 1) {
    void killLadder(child.pid, {
      interrupt: false,
      killAfterMs: opts.ladder?.killAfterMs ?? PROBE_TERM_GRACE_MS,
      ...(opts.ladder?.signal ? { signal: opts.ladder.signal } : {}),
      ...(opts.ladder?.alive ? { alive: opts.ladder.alive } : {}),
      ...(opts.ladder?.sleep ? { sleep: opts.ladder.sleep } : {}),
    }).then((how) => {
      if (how === 'killed') log.warn('mcp.probe.sigkill', { pid: child.pid, note: 'the probe ignored SIGTERM — an npx shim, most likely' });
      opts.onEnded?.(how);
    }, () => opts.onEnded?.('failed'));
    return;
  }
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
  opts.onEnded?.('no-pid');
}

type InitEvent = {
  type?: string;
  subtype?: string;
  tools?: unknown;
  mcp_servers?: unknown;
  mcp_server_errors?: unknown;
};

function parseInit(line: string): InitEvent | null {
  if (!line.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(line) as InitEvent;
    return parsed?.type === 'system' && parsed?.subtype === 'init' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Read the event into one row per server we ASKED about, or `null` when the
 * event carried no verdict at all.
 *
 * Driven by the ids we sent, not by what came back: a server the CLI dropped
 * silently must still appear, as `failed`, or the caller would read its absence
 * as "nothing to worry about".
 *
 * The `null` is the distinction that used to be missing, and it is the same one
 * `probeError` exists for everywhere else in this file. An `init` with NO
 * `mcp_servers` key is a CLI that did not answer the question — an older
 * version, a schema change, an event we mis-parsed — and folding that into "all
 * asked servers report nothing, therefore all failed" turns a probe malfunction
 * into a unanimous verdict against every server, which under `require` parks
 * every phase of every plan on this machine at once. An EMPTY array is a
 * different fact and keeps its old meaning: the CLI answered, and the answer is
 * that it loaded none of them.
 */
function readInit(event: InitEvent, asked: string[]): McpHealth[] | null {
  if (!Array.isArray(event.mcp_servers)) return null;
  const statuses = new Map<string, McpStatus>();
  {
    for (const row of event.mcp_servers as { name?: unknown; status?: unknown }[]) {
      if (typeof row?.name !== 'string') continue;
      statuses.set(row.name, normaliseStatus(row.status));
    }
  }

  const errors = new Map<string, { type: string; message: string }>();
  if (Array.isArray(event.mcp_server_errors)) {
    for (const row of event.mcp_server_errors as { name?: unknown; type?: unknown; message?: unknown }[]) {
      if (typeof row?.name !== 'string') continue;
      errors.set(row.name, {
        type: typeof row.type === 'string' ? row.type : 'unknown',
        message: typeof row.message === 'string' ? row.message : 'the CLI skipped this entry',
      });
    }
  }

  const tools = new Map<string, string[]>();
  if (Array.isArray(event.tools)) {
    for (const tool of event.tools) {
      if (typeof tool !== 'string') continue;
      // `mcp__<server>__<tool>`. A server id may not contain `__`, so the first
      // separator after the prefix is the boundary.
      const rest = tool.startsWith('mcp__') ? tool.slice(5) : '';
      const split = rest.indexOf('__');
      if (split <= 0) continue;
      const id = rest.slice(0, split);
      const name = rest.slice(split + 2);
      tools.set(id, [...(tools.get(id) ?? []), name]);
    }
  }

  return asked.map((id) => {
    const error = errors.get(id);
    const status: McpStatus = error ? 'failed' : statuses.get(id) ?? 'failed';
    return {
      id,
      status,
      tools: (tools.get(id) ?? []).sort(),
      ...(error ? { error } : {}),
    };
  });
}

function normaliseStatus(value: unknown): McpStatus {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  switch (raw) {
    case 'connected': return 'connected';
    case 'pending': return 'pending';
    case 'failed': return 'failed';
    case 'needs-auth':
    case 'needs_auth':
    case 'needsauth':
      return 'needs-auth';
    default:
      if (raw) log.warn('mcp.health.unknown-status', { status: raw });
      return 'unknown';
  }
}

/**
 * Whether this status should stop a phase from boarding.
 *
 * `pending` deliberately does not: a remote server with a cached tool list
 * reports pending and connects on its first tool call, which is normal and
 * costs the run nothing. Only a wall — no credentials, or no server — parks.
 */
export function blocksBoarding(status: McpStatus): boolean {
  return status === 'needs-auth' || status === 'failed';
}
