/**
 * MCP servers — the registry (never a secret, never a path), the catalog, the
 * probes and sign-in.
 */

import { request, post, q } from '../http';
import {
  type MCP_LOGIN_STEPS,
  type MCP_STATUSES,
  type MCP_TRANSPORTS,
} from '../../../../shared/ops-vocab.js';

/* ---------------- MCP servers ---------------- */

/** As the CLI spells them in `.mcp.json`. `streamable-http` is normalised to `http`. */
export type McpTransport = (typeof MCP_TRANSPORTS)[number];

/** What the CLI's own `system/init` reports for a server, plus our "never asked". */
export type McpStatus = (typeof MCP_STATUSES)[number];

/** One registered server. Carries no secret and no path — the facade sees to that. */
export interface McpServerView {
  id: string;
  label: string;
  transport: McpTransport;
  url?: string;
  command?: string;
  enabled: boolean;
  auth: {
    kind: 'none' | 'oauth' | 'header' | 'env';
    /** Which values it needs, and whether the console holds each. Never the values. */
    secrets: { ref: string; held: boolean }[];
  };
  status: McpStatus;
  /** When that status was taken, so the UI can age it honestly. */
  checkedAt?: string;
  issue?: string;
  toolCount?: number;
  /** Tools an unattended run could never approve (`requiresUserInteraction`). */
  interactiveTools?: string[];
  /** The advertised tools changed since we last looked — the rug-pull flag. */
  toolsChanged?: { added: string[]; removed: string[]; seenAt: string };
  /**
   * Environment variables this server's command still refers to and nothing
   * supplies. A registration nobody finished — it will never connect, however
   * many times it is probed, and it must never be attached in the belief that
   * it might.
   */
  needsConfig?: string[];
  source?: string;
  lastUsed?: string;
}

export interface McpState {
  servers: McpServerView[];
  allowMcp: boolean;
}

/** One suggestion, from our curated list or from the official registry. */
export interface McpCatalogEntry {
  id: string;
  label: string;
  description: string;
  transport: McpTransport;
  url?: string;
  command?: string;
  args?: string[];
  auth: 'none' | 'oauth' | 'header' | 'env';
  secretRefs?: { kind: 'header' | 'env' | 'var'; name: string; template?: string }[];
  authNote?: string;
  category: string;
  registryName?: string;
  source: 'curated' | 'registry';
  homepage?: string;
}

/** Where the cached copy of the official registry stands (#363). */
export interface McpRegistryState {
  /** `refreshing` — no copy yet, the first read runs; `stale` — searched as it is, read again behind. */
  state: 'fresh' | 'stale' | 'refreshing' | 'unavailable';
  fetchedAt?: string;
  count: number;
  error?: string;
}

export interface McpCatalogResult {
  entries: McpCatalogEntry[];
  /** The registry copy this answer searched. */
  registry?: McpRegistryState;
  /** Set when there is no registry copy to search — curated only. */
  registryError?: string;
}

/** A guided sign-in's step (`MCP_LOGIN_STEPS`). */
export type McpLoginStep = (typeof MCP_LOGIN_STEPS)[number];

/** One guided sign-in, as `GET /api/mcp/:id/login` answers it (#372). */
export interface McpLoginFlow {
  server: string;
  mode: 'embedded' | 'external' | 'command';
  /** The person is not at the machine: the flow takes the browser's address pasted back. */
  remote: boolean;
  step: McpLoginStep;
  startedAt: string;
  /** When the CLI gives up — five minutes after the start. */
  deadline: string;
  /** The sign-in page, once the CLI printed it. */
  authUrl?: string;
  sessionId?: string;
  command: string;
  commands?: string[];
  configDir?: string;
  accountLabel?: string;
  /** Why it failed or timed out, naming the step. */
  detail?: string;
  exitCode?: number;
  pastedAt?: string;
  endedAt?: string;
}

/** The multi-modal outcome of starting `claude mcp login` — as accounts do it. */
export interface McpLoginStart {
  id: string;
  command: string;
  mode: 'embedded' | 'external' | 'command';
  terminal?: { sessionId: string; token: string; expiresAt: number };
  detail?: string;
  /**
   * The `CLAUDE_CONFIG_DIR` the token lands in, and whose it is. Shown rather
   * than assumed: a sign-in that landed somewhere the run does not look is the
   * second half of issue #8, and the only cure for it is saying which dir.
   */
  configDir?: string;
  accountLabel?: string;
  /**
   * Set ONLY when no flow could start. These are the commands that would work
   * run by hand — the card shows them instead of opening a terminal that would
   * fail, which is the whole complaint issue #8 opened with.
   */
  commands?: string[];
  /** The guided flow the sheet walks (#372). */
  flow?: McpLoginFlow;
}

/** The MCP fetchers — merged into `api` by `./index`. */
export const mcpApi = {
  /* ---- MCP servers ---- */
  mcp: () => request<McpState>('/api/mcp'),
  /** Ungated: browsing what exists is how somebody decides to turn the flag on. */
  mcpCatalog: (query: string, registry = true) =>
    request<McpCatalogResult>(`/api/mcp/catalog?q=${q(query)}${registry ? '' : '&registry=0'}`),
  mcpAdd: (body: Record<string, unknown>) => post<{ server: McpServerView }>('/api/mcp', body),
  mcpDelete: (id: string) => request<{ removed: boolean }>(`/api/mcp/${q(id)}`, { method: 'DELETE' }),
  /**
   * One server's registration: switched on or off, renamed (`label`, the name a
   * page shows — the id a plan names never moves), or a secret it needs stored
   * in the keychain under the ref it names.
   */
  mcpPatch: (
    id: string,
    body: {
      enabled?: boolean;
      label?: string;
      secretRef?: { kind: string; name: string };
      secret?: string;
      /** A value for each `${VAR}` the registration writes and nothing supplies (#363). */
      vars?: Record<string, string>;
    },
  ) =>
    request<{ server: McpServerView }>(`/api/mcp/${q(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  /**
   * Starts `claude mcp login <id>` where a person can answer it — with
   * `--no-browser` only when the person is not at the machine (#372).
   * `accountId` names a PROFILE account: the token lands in its config dir, so
   * the runs that spend it see the server signed in; absent, this console's own.
   */
  mcpLogin: (id: string, options: { accountId?: string } = {}) =>
    post<McpLoginStart>(`/api/mcp/${q(id)}/login`, options.accountId ? { accountId: options.accountId } : {}),
  /** The guided sign-in as it stands — its step, the sign-in page, the deadline, the ending. */
  mcpLoginFlow: (id: string) => request<{ flow: McpLoginFlow }>(`/api/mcp/${q(id)}/login`),
  /** The paste-back: the address the browser landed on, handed to the CLI waiting for it. */
  mcpLoginPaste: (id: string, url: string) =>
    post<{ flow: McpLoginFlow }>(`/api/mcp/${q(id)}/login/paste`, { url }),
  /** Re-probe every enabled server. Not behind the flag — checking changes nothing. */
  mcpRefresh: () => post<{ servers: McpServerView[] }>('/api/mcp/refresh', {}),
  /** "I have seen that its tools changed." Clears the rug-pull flag. */
  mcpAcknowledge: (id: string) => post<{ acknowledged: boolean }>(`/api/mcp/${q(id)}/acknowledge`, {}),
};
