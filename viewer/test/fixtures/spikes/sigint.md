# Probe — SIGINT against a streaming-input `claude -p` mid-tool: does the turn close with a `result`?

cli: 2.1.270
date: 2026-09-14
verdict: honoured
positive: yes
cost_usd: 0.0172 (three arms on haiku, each capped at `--max-budget-usd 0.08`)
settles: chapter 09 row 57 ("SIGINT ends the turn") · SES-1 · gate ACC-3.1 · zero-touch-console phase 4's `INT_GRACE_MS`

**Reading the verdict.** The console drives every phase in streaming-input mode (`--input-format
stream-json`, stdin held open). A haiku session was asked to run `sleep 20` with Bash and was sent
SIGINT 1.5 s after its `tool_use` line, with the Bash call running. In all three arms the CLI closed
the turn: it wrote an `is_error: true` `tool_result` for the running call, a `[Request interrupted by
user for tool use]` user line, then **one `result` ~10 ms after the signal** —
`subtype: error_during_execution`, `is_error: true`, `terminal_reason: aborted_tools`,
`stop_reason: tool_use`, `num_turns: 3`, a real `total_cost_usd` — and exited **code 0, no signal,
~524 ms after the signal**, with stdin closed. No SIGTERM was needed in any arm. SIGTERM, by the docs,
leaves the turn unfinished with no `result` at all; that difference is the whole ledger.

| arm | order | SIGINT → `result` | SIGINT → exit | exit | TERM needed | result |
|---|---|---|---|---|---|---|
| `A` | close stdin, then SIGINT (the console's abort order) | 10 ms | 525 ms | code 0 | no | `error_during_execution` · `is_error` · `aborted_tools` · $0.0114 |
| `B` | SIGINT with stdin open; stdin closed when the `result` landed (what `spawn.ts`'s result handler does) | 9 ms | 523 ms | code 0 | no | same · $0.0029 |
| `C` | close stdin, SIGINT, a second SIGINT 200 ms later | 10 ms | 524 ms | code 0 | no | same · $0.0029 |

**What else the stream showed.**
- **One API turn is several `assistant` messages.** The `thinking` block and the `tool_use` block of one
  response arrived as two `assistant` lines sharing one `message.id`; a count of assistant lines
  over-counts turns, a count of distinct `message.id`s does not.
- **An interrupt reads like a refusal.** The interrupted call's `tool_result` says *"The user doesn't want
  to proceed with this tool use. The tool use was rejected …"* — so a permission-refusal detector must
  key on the CLI's own permission sentence (*"Claude requested permissions to …"*) or a
  `system/permission_denied` for the same `tool_use_id`, never on "rejected". `permission_denials` was
  `[]` in every arm.
- **The second SIGINT was harmless** once the `result` had been written (arm C); the console still sends
  one per process so two callers share one grace.
- **`rate_limit_event` on 2.1.270** carried `status`, `resetsAt`, `rateLimitType`, `overageStatus`,
  `overageDisabledReason`, `isUsingOverage` and `unifiedWindows: {five_hour: {utilization, resetsAt},
  seven_day: {utilization, resetsAt}}` — utilization as a fraction, and no top-level `utilization` on an
  `allowed` event.

**Isolation.** Run from a scratch directory with `--setting-sources project --strict-mcp-config
--allowedTools "Bash(sleep:*)"`, every `CLAUDE_CODE_*`/`CLAUDECODE`/`PE_*` variable unset, `detached`,
the prompt written as one NDJSON user message on stdin.

## Raw evidence (arm `A`; ids pseudonymised, cwd and usage blocks dropped)

- argv:
```
claude --print --output-format stream-json --input-format stream-json --replay-user-messages --verbose --model haiku --max-turns 4 --max-budget-usd 0.08 --setting-sources project --strict-mcp-config --allowedTools Bash(sleep:*)
```
- stdin (one line, then held open until the signal):
```jsonl
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Use the Bash tool to run exactly this command: sleep 20 — then reply with the single word DONE."}]}}
```
- `system/init`: claude_code_version=`2.1.270` model=`claude-haiku-4-5-20251001` permissionMode=`default` · capabilities: `["interrupt_receipt_v1","interrupt_cancel_queued_v1","msg_lifecycle_v1"]`
- stream lines that matter (`t` = ms from spawn; SIGINT sent at 4602):
```jsonl
{"t":1617,"line":{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1789379400,"rateLimitType":"five_hour","overageStatus":"rejected","overageDisabledReason":"org_level_disabled","isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":0.31,"resetsAt":1789379400},"seven_day":{"utilization":0.06,"resetsAt":1789956000}}}}}
{"t":2924,"line":{"type":"assistant","message":{"id":"msg_sigint_a","content":[{"type":"thinking"}]}}}
{"t":3101,"line":{"type":"assistant","message":{"id":"msg_sigint_a","content":[{"type":"tool_use","id":"toolu_sigint_a","name":"Bash","input":{"command":"sleep 20","description":"Wait for 20 seconds"}}]}}}
{"t":4611,"line":{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.","is_error":true,"tool_use_id":"toolu_sigint_a"}]}}}
{"t":4611,"line":{"type":"user","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user for tool use]"}]}}}
{"t":4612,"line":{"type":"result","subtype":"error_during_execution","is_error":true,"terminal_reason":"aborted_tools","stop_reason":"tool_use","num_turns":3,"total_cost_usd":0.0114327,"permission_denials":[],"errors":["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use"],"duration_ms":3988,"duration_api_ms":3462,"queued_turn_count":0,"result_index":0,"session_id":"00000000-0000-4000-8000-00000000000a"}}
```
- exit: code `0`, signal `null`, 525 ms after SIGINT · stderr: empty
