# Relay smoke — the presence-only host and the `defer` round trip in STREAMING-input mode

cli: 2.1.271
date: 2026-09-15
verdict: honoured
cost_usd: 0.0259 (three sessions)
settles: exit criterion 4 of zero-touch-console phase 14 — the S3 round trip, measured in the spawn mode the console actually uses

**Why this exists.** Phase 1 measured `defer` (spike S3) with a positional prompt and stdin from `/dev/null`. The console drives every
session with `--input-format stream-json` and writes its boot prompt — and, on a resume, a resume brief — down stdin. Phase 14 built the
relay on the S3 verdict; this confirms it holds in that mode, and that the console-owned presence-only host (`viewer/server/relay-host.ts`,
run by the console node) connects and makes the CLI offer `AskUserQuestion`.

| arm | what | result |
|---|---|---|
| `host` | one turn, `--permission-prompt-tool mcp__pcrelay__hold`, the host in `--mcp-config` + `--strict-mcp-config` | `system/init.mcp_servers` = `[{"name":"pcrelay","status":"connected"}]`; `AskUserQuestion` in `system/init.tools`; `capabilities` names no hook |
| `defer` | the forcing prompt as a stream-json message; a `PreToolUse` `http` hook answering `defer` | `stop_reason: tool_deferred`, `deferred_tool_use.name: AskUserQuestion`; the process exits with stdin at EOF |
| `resume` | `--resume <id>` with a stream-json user message (a resume brief); the same hook answering `allow` + `updatedInput.answers` | the hook fires AGAIN for the SAME `tool_use_id` before the new message is taken; the tool result carries the hook answer; the model replies `ANSWER=Red`, then takes the brief as a second turn |

**Argv (all three, paths redacted):** `claude -p --model haiku --max-turns <1|3> --max-budget-usd <0.05|0.10> --input-format stream-json --output-format stream-json --verbose [--include-hook-events] --setting-sources project --settings <settings> --permission-mode default --strict-mcp-config --mcp-config <mcp.json> --permission-prompt-tool mcp__pcrelay__hold (--session-id <uuid> | --resume <uuid>) < <message.jsonl>`, every `CLAUDE_CODE_*`/`CLAUDECODE` variable of the driving session unset, `CLAUDE_CODE_MAX_RETRIES=2`, cwd a scratchpad directory no console owns.

`mcp.json`: `{"mcpServers":{"pcrelay":{"type":"stdio","command":"<node>","args":["<skill>/viewer/server/relay-host.ts"]}}}`

## Raw evidence

### `host` — system/init (tools trimmed to the question tools)
```json
{"type":"system","subtype":"init","claude_code_version":"2.1.271","mcp_servers":[{"name":"pcrelay","status":"connected"}],"capabilities":["interrupt_receipt_v1","interrupt_cancel_queued_v1","msg_lifecycle_v1"],"tools_offered":["AskUserQuestion","EnterPlanMode","ExitPlanMode"]}
```

### `defer` — the stream lines that matter
```jsonl
{"type":"assistant","content":[]}
{"type":"assistant","content":[{"type":"tool_use","id":"toolu_01YaQzyCujmYF2AdDhh2R122","name":"AskUserQuestion"}]}
{"type":"system","subtype":"hook_response","hook_name":"PreToolUse:AskUserQuestion","outcome":"success","output":"{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"defer\",\"permissionDecisionReason\":\"smoke: defer\"}}"}
{"type":"result","subtype":"success","stop_reason":"tool_deferred","terminal_reason":"tool_deferred","is_error":false,"num_turns":1,"total_cost_usd":0.009697,"permission_denials":[],"deferred_tool_use":{"id":"toolu_01YaQzyCujmYF2AdDhh2R122","name":"AskUserQuestion"},"result":""}
```

### `resume` — the stream lines that matter
```jsonl
{"type":"system","subtype":"hook_response","hook_name":"PreToolUse:AskUserQuestion","outcome":"success","output":"{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"allow\",\"permissionDecisionReason\":\"smoke: answered\",\"updatedInput\":{\"questions\":[{\"question\":\"Which colour should the banner be?\",\"header\":\"Colour\",\"options\":[{\"label\":\"Red\",\"description\":\"warm\"},{\"label\":\"Blue (Recommended)\",\"description\":\"cool\"}],\"multiSelect\":false}],\"answers\":{\"Which colour should the banner be?\":\"Red\"}}}}"}
{"type":"user","tool_result":[{"tool_use_id":"toolu_01YaQzyCujmYF2AdDhh2R122","content":"Your questions have been answered: \"Which colour should the banner be?\"=\"Red\". You can now continue with these answers in mind."}]}
{"type":"assistant","content":[]}
{"type":"assistant","content":[{"type":"text","text":"ANSWER=Red"}]}
{"type":"result","subtype":"success","stop_reason":"end_turn","terminal_reason":"completed","is_error":false,"num_turns":1,"total_cost_usd":0.0024239000000000005,"permission_denials":[],"result":"ANSWER=Red"}
{"type":"assistant","content":[]}
{"type":"assistant","content":[{"type":"text","text":"The task is complete. I called AskUserQuestion with the banner color question, received the answer \"Red\", and replied with:\n\nANSWER=Red"}]}
{"type":"result","subtype":"success","stop_reason":"end_turn","terminal_reason":"completed","is_error":false,"num_turns":1,"total_cost_usd":0.005125900000000001,"permission_denials":[],"result":"The task is complete. I called AskUserQuestion with the banner color question, received the answer \"Red\", and replied with:\n\nANSWER=Red"}
```

### The hook listener (both calls, verbatim)
```jsonl
{"at":"2026-09-15T03:31:22.479Z","url":"/pretool","tool":"AskUserQuestion","tool_use_id":"toolu_01YaQzyCujmYF2AdDhh2R122","event":"PreToolUse","reply":{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"defer","permissionDecisionReason":"smoke: defer"}}}
{"at":"2026-09-15T03:31:37.176Z","url":"/pretool","tool":"AskUserQuestion","tool_use_id":"toolu_01YaQzyCujmYF2AdDhh2R122","event":"PreToolUse","reply":{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"smoke: answered","updatedInput":{"questions":[{"question":"Which colour should the banner be?","header":"Colour","options":[{"label":"Red","description":"warm"},{"label":"Blue (Recommended)","description":"cool"}],"multiSelect":false}],"answers":{"Which colour should the banner be?":"Red"}}}}}
```
