#!/usr/bin/env node
// A `claude` that is not claude — the e2e fixture's LIVE LANE.
//
// The fixture console starts one real run on the toured plan, so the pages that
// show work in flight have some: a session that announces itself the way the
// CLI does (a `system/init` frame, then an assistant turn) and then simply stays
// — no model, no network, no spend — until the console ends it. The probes the
// console runs on its own (`--version`, `auth status`, `mcp list`) get the
// answers a signed-in machine gives.
'use strict';

const argv = process.argv.slice(2);
const done = (text) => process.stdout.write(text, () => process.exit(0));

if (argv.includes('--version') || argv[0] === '-v') done('2.1.300 (Claude Code)\n');
else if (argv[0] === 'auth' && argv[1] === 'status')
  done(`${JSON.stringify({ loggedIn: true, email: 'stub@example.invalid' })}\n`);
else if (argv[0] === 'mcp') done('No MCP servers configured.\n');
else {
  const sid = 'e2e00000-0000-4000-8000-000000000001';
  const say = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
  say({
    type: 'system',
    subtype: 'init',
    session_id: sid,
    model: 'stub-1',
    tools: [],
    claude_code_version: '2.1.300',
    capabilities: [],
    mcp_servers: [],
  });
  say({
    type: 'assistant',
    session_id: sid,
    message: {
      role: 'assistant',
      model: 'stub-1',
      content: [{ type: 'text', text: 'Measuring every page at four widths.' }],
      usage: { input_tokens: 1200, output_tokens: 40 },
    },
  });
  // Whatever arrives on stdin (a nudge, a steer) is read and ignored; the lane
  // lives until it is signalled, which is how the console ends a session —
  // or until its stdin ends, which is how a real `claude` in streaming-input
  // mode learns its console has gone. A lane is spawned detached, so after an
  // unclean console death nothing else would ever reach it: two stubs lived on
  // at PPID 1 for as long as the machine did (#90).
  process.stdin.on('data', () => {});
  process.stdin.on('error', () => {});
  // Never silent, never a new row. The console raises a "silent for …" card
  // once a running lane has produced nothing for a while, so a page measured
  // early and the same page measured minutes later would differ. Any streamed
  // text delta keeps the lane's last-output clock fresh, and consecutive deltas
  // fold into ONE partial line — so the lane streams an invisible character from
  // the start and every twenty seconds after, and every page reads the same at
  // minute one and at minute six.
  const breathe = () =>
    say({
      type: 'stream_event',
      session_id: sid,
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '\u200b' } },
    });
  breathe();
  const hold = setInterval(breathe, 20_000);
  const bye = () => {
    clearInterval(hold);
    process.exit(0);
  };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
  process.stdin.on('end', bye);
  process.stdin.on('close', bye);
}
