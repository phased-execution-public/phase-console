/** This console's MCP servers, their health, and the catalog to add from. */

import { keepPreviousData, useQuery } from '@tanstack/react-query';
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
  });
}
