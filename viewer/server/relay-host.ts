/**
 * The relay's permission host — present, and silent (zero-touch-console phase
 * 14; phase 1's transport ruling).
 *
 * Spike S1 measured on CLI 2.1.270 that a `claude -p` session offers
 * `AskUserQuestion` ONLY when it has a permission host: without one the tool is
 * absent from `system/init.tools` and there is nothing for the relay to answer.
 * So a relay-armed session is started with `--permission-prompt-tool` naming
 * this server's one tool. It exists to be PRESENT. It must never answer first:
 * spike S2 measured the CLI putting a call to the host and to the
 * `PermissionRequest` hook at the same instant and taking the first decision,
 * and a host that answered at once beat the console's hook. The console answers
 * through its hooks; this answers nothing while they can.
 *
 * What it does do is fail CLOSED when nothing else will. If the console is gone
 * the hook call fails, the host is the only thing left holding the call, and a
 * permission prompt "never times out" — so after the hook's own hour and a
 * margin (`RELAY_HOST_BACKSTOP_MS`) it answers `deny`, saying why. The CLI
 * cancels a call the hook decided first (`notifications/cancelled`), which drops
 * the backstop with it.
 *
 * A stdio MCP server in the protocol's plainest form — newline-delimited
 * JSON-RPC 2.0, four methods — with no imports from the console, because the CLI
 * starts it with the console's node and nothing else: it must run from a clone
 * (`.ts`, types stripped by node) and from a packed install (the emitted `.js`
 * beside it), which is why its path is derived from this module's own URL.
 */

import { fileURLToPath } from 'node:url';

/** The server's name in the run's `--mcp-config`. Short and plain: it becomes part of a tool name. */
export const RELAY_HOST_SERVER = 'pcrelay';

/** The one tool, as the CLI names it — what `--permission-prompt-tool` is given. */
export const RELAY_HOST_TOOL = `mcp__${RELAY_HOST_SERVER}__hold`;

/**
 * When the host gives up holding a call: the hook's hour (`HOOK_TIMEOUT_SECONDS`
 * in `runner/approvals.ts`, 3600) and a minute. Written out rather than imported
 * — this process imports nothing from the console — and `approvals.test.ts`
 * holds it above the hook's.
 */
export const RELAY_HOST_BACKSTOP_MS = 3_660_000;

/** The message a backstop denial carries to the session. */
export const RELAY_HOST_DENIAL = 'The console supervising this run did not answer this request within the hour its '
  + 'hook allows, so it is refused. This is not a person rejecting your work: declare what you need with '
  + '`phase-outcome.sh … blocked --needs <key>` and stop.';

/** This file's path in the form this process runs — `.js` in a packed install, `.ts` in a clone. */
export function relayHostEntry(): string {
  const here = import.meta.url;
  return fileURLToPath(new URL(here.endsWith('.js') ? './relay-host.js' : './relay-host.ts', here));
}

/** The `--mcp-config` entry that starts this host under the console's own node. */
export function relayHostConfig(execPath: string = process.execPath): { type: 'stdio'; command: string; args: string[] } {
  return { type: 'stdio', command: execPath, args: [relayHostEntry()] };
}

type Message = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };

/**
 * One message in, zero or one out — the protocol, pure, so a test can drive it
 * without a process. `hold` is how a `tools/call` is kept open: the caller owns
 * the timer and the eventual reply.
 */
export function answerMessage(
  message: Message,
  hold: (id: string | number, reply: () => Record<string, unknown>) => void,
): Record<string, unknown> | null {
  const id = message.id;
  const reply = (result: Record<string, unknown>) => ({ jsonrpc: '2.0', id, result });
  switch (message.method) {
    case 'initialize':
      return reply({
        protocolVersion: typeof message.params?.protocolVersion === 'string' ? message.params.protocolVersion : '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'phase-console-relay', version: '1' },
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({
        tools: [{
          name: 'hold',
          description: 'Holds a permission prompt for the console supervising this run, which answers it through '
            + 'its hooks. Never answers first.',
          inputSchema: { type: 'object', additionalProperties: true },
        }],
      });
    case 'tools/call':
      if (id === undefined || id === null) return null;
      hold(id, () => reply({
        content: [{ type: 'text', text: JSON.stringify({ behavior: 'deny', message: RELAY_HOST_DENIAL }) }],
      }));
      return null;
    default:
      // A notification (no id) is never answered; a request we do not know is.
      if (id === undefined || id === null) return null;
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${message.method ?? ''}` } };
  }
}

const invokedDirectly = process.argv[1] !== undefined
  && (process.argv[1].endsWith('relay-host.ts') || process.argv[1].endsWith('relay-host.js'));

if (invokedDirectly) {
  const backstop = Number(process.env.PHASE_CONSOLE_RELAY_HOST_BACKSTOP_MS) > 0
    ? Number(process.env.PHASE_CONSOLE_RELAY_HOST_BACKSTOP_MS)
    : RELAY_HOST_BACKSTOP_MS;
  const held = new Map<string | number, NodeJS.Timeout>();
  const send = (payload: Record<string, unknown>) => { process.stdout.write(`${JSON.stringify(payload)}\n`); };
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf('\n');
      if (!line) continue;
      let message: Message;
      try { message = JSON.parse(line) as Message; } catch { continue; }
      if (message.method === 'notifications/cancelled') {
        const target = (message.params as { requestId?: string | number } | undefined)?.requestId;
        if (target !== undefined && held.has(target)) {
          clearTimeout(held.get(target));
          held.delete(target);
        }
        continue;
      }
      const out = answerMessage(message, (callId, later) => {
        held.set(callId, setTimeout(() => { held.delete(callId); send(later()); }, backstop));
      });
      if (out) send(out);
    }
  });
  process.stdin.on('end', () => process.exit(0));
}
