/** This console's MCP servers, their health, and the catalog to add from. */

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { MCP_LOGIN_ENDS } from '../../../shared/ops-vocab.js';
import { api } from './api';
import { keys } from './keys';

/** This instance's MCP servers with their health — live via the `mcp` event. */
export function useMcp(enabled = true) {
  return useQuery({ queryKey: keys.mcp(), queryFn: api.mcp, enabled });
}

/**
 * The catalog for one search string.
 *
 * Its own key per query rather than one cache entry, because the registry half
 * of the answer is a network round trip and re-typing a search you already ran
 * should not repeat it. `staleTime: Infinity` (the app default) is right here:
 * the published catalog does not move while somebody is reading it.
 */
export function useMcpCatalog(query: string, enabled = true) {
  return useQuery({
    queryKey: keys.mcpCatalog(query),
    queryFn: () => api.mcpCatalog(query),
    enabled,
    placeholderData: keepPreviousData,
    // The registry copy is read behind the answer when it is missing or old
    // (#363): ask again every few seconds until the copy is in, so a search
    // typed while it was being read finds what it holds.
    refetchInterval: (query) => {
      const state = query.state.data?.registry?.state;
      return state === 'refreshing' || state === 'stale' ? 4_000 : false;
    },
  });
}

/**
 * One server's guided sign-in (#372), read every second while it runs — the
 * step, the sign-in page's address once the CLI printed it, the ending.
 */
export function useMcpLoginFlow(id: string, enabled = true) {
  return useQuery({
    queryKey: keys.mcpLogin(id),
    queryFn: () => api.mcpLoginFlow(id),
    enabled,
    retry: false,
    refetchInterval: (query) => {
      const step = query.state.data?.flow.step;
      return step && (MCP_LOGIN_ENDS as readonly string[]).includes(step) ? false : 1_000;
    },
  });
}
