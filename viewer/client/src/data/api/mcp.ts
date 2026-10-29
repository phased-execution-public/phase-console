/**
 * MCP servers — the registry (never a secret, never a path), the catalog, the
 * probes and sign-in. The shapes are the wire's (`shared/wire/mcp.js`).
 */

import { request, post, q } from '../http';
import type {
  McpAcknowledgeAnswer,
  McpAddBody,
  McpCatalogResult,
  McpFlowAnswer,
  McpLoginStart,
  McpPatchBody,
  McpRemoveAnswer,
  McpServerAnswer,
  McpServersAnswer,
  McpState,
} from '@shared/wire/mcp.js';

export type {
  McpCatalogEntry,
  McpCatalogResult,
  McpLoginFlow,
  McpLoginStart,
  McpLoginStep,
  McpRegistryState,
  McpServerView,
  McpState,
  McpStatus,
  McpTransport,
} from '@shared/wire/mcp.js';

/** The MCP fetchers — merged into `api` by `./index`. */
export const mcpApi = {
  /* ---- MCP servers ---- */
  mcp: () => request<McpState>('/api/mcp'),
  /** Ungated: browsing what exists is how somebody decides to turn the flag on. */
  mcpCatalog: (query: string, registry = true) =>
    request<McpCatalogResult>(`/api/mcp/catalog?q=${q(query)}${registry ? '' : '&registry=0'}`),
  mcpAdd: (body: McpAddBody) => post<McpServerAnswer>('/api/mcp', body),
  mcpDelete: (id: string) => request<McpRemoveAnswer>(`/api/mcp/${q(id)}`, { method: 'DELETE' }),
  /**
   * One server's registration: switched on or off, renamed (`label`, the name a
   * page shows — the id a plan names never moves), or a secret it needs stored
   * in the keychain under the ref it names.
   */
  mcpPatch: (id: string, body: McpPatchBody) =>
    request<McpServerAnswer>(`/api/mcp/${q(id)}`, {
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
  mcpLoginFlow: (id: string) => request<McpFlowAnswer>(`/api/mcp/${q(id)}/login`),
  /** The paste-back: the address the browser landed on, handed to the CLI waiting for it. */
  mcpLoginPaste: (id: string, url: string) => post<McpFlowAnswer>(`/api/mcp/${q(id)}/login/paste`, { url }),
  /** Re-probe every enabled server. Not behind the flag — checking changes nothing. */
  mcpRefresh: () => post<McpServersAnswer>('/api/mcp/refresh', {}),
  /** "I have seen that its tools changed." Clears the rug-pull flag. */
  mcpAcknowledge: (id: string) => post<McpAcknowledgeAnswer>(`/api/mcp/${q(id)}/acknowledge`, {}),
};
