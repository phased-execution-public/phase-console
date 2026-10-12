import { describeWord } from '@shared/status-model.js';
import { DotWord } from './dot-word';
import type { Chrome, WordOf } from './view';

/** An MCP server's connection. `needs-auth` is amber: only a person can sign a server in. */
export function McpStatus({ status, ...chrome }: { status: WordOf<'mcp'> | null | undefined } & Chrome) {
  return <DotWord view={describeWord('mcp', status)} {...chrome} />;
}
