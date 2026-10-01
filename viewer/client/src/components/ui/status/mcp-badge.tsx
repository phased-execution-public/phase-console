import { describeWord } from '@shared/status-model.js';
import { ViewBadge, type BadgeChrome, type WordOf } from './view-badge';

/** An MCP server's connection. `needs-auth` is amber: only a person can sign a server in. */
export function McpBadge({ status, ...chrome }: { status: WordOf<'mcp'> | null | undefined } & BadgeChrome) {
  return <ViewBadge view={describeWord('mcp', status)} {...chrome} />;
}
