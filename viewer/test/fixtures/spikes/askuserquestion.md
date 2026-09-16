# Spike S1 — `AskUserQuestion` answered by a `PreToolUse` hook (`allow` + `updatedInput.answers`)

cli: 2.1.270
date: 2026-09-14
verdict: honoured
positive: no
availability: needs-host
cost_usd: 0.0424 (two arms)
settles: DOC-9 / chapter 09 row 61 · gate ACC-8.1 · finding QRL-10

**Reading the verdict.** The hook's `allow` + `updatedInput.answers` is **honoured** the moment the
tool is offered: the model receives *"Your questions have been answered: "<question>"="<label>""*
and replies with the hook's label, not the recommended one. But the tool is **offered only when the
run has a permission host** (`--permission-prompt-tool`): in the host-less arm `AskUserQuestion` is
absent from `system/init.tools`, the model says so, and the hook never fires. So the audit's
"hook alone makes the tool available" reading (DOC-9) is **negative** — a host is needed for
availability, and the host need not answer: in arm B the host's `permit` tool was connected and
never called; the `PreToolUse` hook decided alone.

| arm | host | `AskUserQuestion` in `system/init.tools` | hook fired | answer the model got | verdict |
|---|---|---|---|---|---|
| `s1a` | none | **no** | no | — (model: "I don't see an AskUserQuestion tool") | ignored |
| `s1b` | `mcp__spike__permit` (connected, never called) | **yes** (also `EnterPlanMode`, `ExitPlanMode`) | yes, `PreToolUse:AskUserQuestion` | `Red` — the hook's, not the recommended `Blue` | honoured |

**What each arm pinned.** Matcher `AskUserQuestion`; transport `http` (`type: "http"`, `timeout: 600`,
answered 200 + JSON); `--permission-mode default`; the `answers` key rule holds as documented — keys
are the question **text**, values the option **label** (`{"Which colour should the banner be?":"Red"}`),
with the original `questions` array echoed in `updatedInput`; `system/init.capabilities` is
`["interrupt_receipt_v1","interrupt_cancel_queued_v1","msg_lifecycle_v1"]` — a third member the
audit did not list, and none names anything about hooks or prompts.

**Isolation.** cwd = a scratchpad directory no console owns; `--setting-sources project` (no user
settings: no presence hook, no `Bash(*)` allow, no `defaultMode: auto`); the spike's own `--settings`
states `permissions.allow: ["Read"]`; `--strict-mcp-config` on every arm; every `CLAUDE_CODE_*`
variable of the driving session unset; `CLAUDE_CODE_MAX_RETRIES=2`. The pe-hub console's
`GET /api/sessions/registry` read 5 records before and 5 after, none of them a spike session.

**Forcing prompt (verbatim, both arms).** `Call the AskUserQuestion tool exactly once with one
question: header "Colour", question "Which colour should the banner be?", options "Red" (description
"warm") and "Blue (Recommended)" (description "cool"), multiSelect false. When you have the answer,
reply with exactly one line: ANSWER=<the label you received>. Use no other tool.`
The listener always answers the **non**-recommended option (`Red`) and the host the recommended one
(`Blue (Recommended)`), so the final line names which answerer was honoured.

**Listener rule file at the time:** `{"pretool":"allow","perm":"allow"}`.

## Raw evidence (generated from the streams and the listener/host logs; paths redacted)

### Arm `s1a`
- session: `e30f9968-e5d1-4135-9f8a-18b03374a9ed` · exit: 0 · cost_usd: 0.020654699999999998
- argv:
```
claude -p --model haiku --max-turns 2 --max-budget-usd 0.50 --output-format stream-json --verbose --include-hook-events --setting-sources project --settings <spikes>/s1.json --permission-mode default --strict-mcp-config --session-id e30f9968-e5d1-4135-9f8a-18b03374a9ed Call\ the\ AskUserQuestion\ tool\ exactly\ once\ with\ one\ question:\ header\ \"Colour\"\,\ question\ \"Which\ colour\ should\ the\ banner\ be\?\"\,\ options\ \"Red\"\ \(description\ \"warm\"\)\ and\ \"Blue\ \(Recommended\)\"\ \(description\ \"cool\"\)\,\ multiSelect\ false.\ When\ you\ have\ the\ answer\,\ reply\ with\ exactly\ one\ line:\ ANSWER=\<the\ label\ you\ received\>.\ Use\ no\ other\ tool.
```
- settings (`s1.json`):
```json
{"permissions":{"allow":["Read"]},"hooks":{"PreToolUse":[{"matcher":"AskUserQuestion","hooks":[{"type":"http","url":"http://127.0.0.1:47311/pretool","timeout":600}]}]}}
```
- stderr:
```
exit=0
```
- `system/init`: claude_code_version=`2.1.270` model=`claude-haiku-4-5-20251001` permissionMode=`default` apiKeySource=`none`
  - tools: `["Task","Bash","CronCreate","CronDelete","CronList","DesignSync","Edit","EnterWorktree","ExitWorktree","ListAgents","Monitor","NotebookEdit","PushNotification","Read","RemoteTrigger","ReportFindings","ScheduleWakeup","SendMessage","Skill","TaskCreate","TaskGet","TaskList","TaskOutput","TaskStop","TaskUpdate","ToolSearch","WebFetch","WebSearch","Workflow","Write"]`
  - AskUserQuestion offered: **no**
  - mcp_servers: `[]` · capabilities: `["interrupt_receipt_v1","interrupt_cancel_queued_v1","msg_lifecycle_v1"]`
- stream lines that matter (`--output-format stream-json --verbose --include-hook-events`; `thinking_tokens`, `rate_limit_event`, `command_lifecycle` and the usage blocks dropped):
```jsonl
{"type":"assistant","text":"I don't see an `AskUserQuestion` tool available in my current environment. The available tools I have are:\n\n- Agent\n- Bash\n- Edit\n- ListAgents\n- Read\n- ReportFindings\n- ScheduleWakeup\n- Skill\n- ToolSearch\n- Workflow\n- Write\n\nAnd the deferred tools are: CronCreate, CronDelete, CronList, DesignSync, EnterWorktree, ExitWorktree, Monitor, NotebookEdit, PushNotification, RemoteTrigger, SendMessage, TaskCreate, TaskGet, TaskList, TaskOutput, TaskStop, TaskUpdate, WebFetch, WebSearch.\n\nCould you clarify which tool I should use, or check if `AskUserQuestion` is available in your environment?"}
{"type":"result","subtype":"success","stop_reason":"end_turn","terminal_reason":"completed","is_error":false,"num_turns":1,"total_cost_usd":0.020654699999999998,"permission_denials":[],"result":"I don't see an `AskUserQuestion` tool available in my current environment. The available tools I have are:\n\n- Agent\n- Bash\n- Edit\n- ListAgents\n- Read\n- ReportFindings\n- ScheduleWakeup\n- Skill\n- ToolSearch\n- Workflow\n- Write\n\nAnd the deferred tools are: CronCreate, CronDelete, CronList, DesignSync, EnterWorktree, ExitWorktree, Monitor, NotebookEdit, PushNotification, RemoteTrigger, SendMessage, TaskCreate, TaskGet, TaskList, TaskOutput, TaskStop, TaskUpdate, WebFetch, WebSearch.\n\nCould you clarify which tool I should use, or check if `AskUserQuestion` is available in your environment?"}
```
- hook requests received by the listener: **none** for this session

### Arm `s1b`
- session: `290144af-729a-4195-b3ab-6cd584ef91e3` · exit: 0 · cost_usd: 0.0217432
- argv:
```
claude -p --model haiku --max-turns 2 --max-budget-usd 0.50 --output-format stream-json --verbose --include-hook-events --setting-sources project --settings <spikes>/s1.json --permission-mode default --strict-mcp-config --session-id 290144af-729a-4195-b3ab-6cd584ef91e3 --mcp-config <spikes>/mcp.json --permission-prompt-tool mcp__spike__permit Call\ the\ AskUserQuestion\ tool\ exactly\ once\ with\ one\ question:\ header\ \"Colour\"\,\ question\ \"Which\ colour\ should\ the\ banner\ be\?\"\,\ options\ \"Red\"\ \(description\ \"warm\"\)\ and\ \"Blue\ \(Recommended\)\"\ \(description\ \"cool\"\)\,\ multiSelect\ false.\ When\ you\ have\ the\ answer\,\ reply\ with\ exactly\ one\ line:\ ANSWER=\<the\ label\ you\ received\>.\ Use\ no\ other\ tool.
```
- settings (`s1.json`):
```json
{"permissions":{"allow":["Read"]},"hooks":{"PreToolUse":[{"matcher":"AskUserQuestion","hooks":[{"type":"http","url":"http://127.0.0.1:47311/pretool","timeout":600}]}]}}
```
- stderr:
```
Warning: no stdin data received in 3s, proceeding without it. If piping from a slow command, redirect stdin explicitly: < /dev/null to skip, or wait longer.
exit=0
```
- `system/init`: claude_code_version=`2.1.270` model=`claude-haiku-4-5-20251001` permissionMode=`default` apiKeySource=`none`
  - tools: `["Task","AskUserQuestion","Bash","CronCreate","CronDelete","CronList","DesignSync","Edit","EnterPlanMode","EnterWorktree","ExitPlanMode","ExitWorktree","ListAgents","Monitor","NotebookEdit","PushNotification","Read","RemoteTrigger","ReportFindings","ScheduleWakeup","SendMessage","Skill","TaskCreate","TaskGet","TaskList","TaskOutput","TaskStop","TaskUpdate","ToolSearch","WebFetch","WebSearch","Workflow","Write"]`
  - AskUserQuestion offered: **yes**
  - mcp_servers: `[{"name":"spike","status":"connected"}]` · capabilities: `["interrupt_receipt_v1","interrupt_cancel_queued_v1","msg_lifecycle_v1"]`
- stream lines that matter (`--output-format stream-json --verbose --include-hook-events`; `thinking_tokens`, `rate_limit_event`, `command_lifecycle` and the usage blocks dropped):
```jsonl
{"type":"assistant","tool_use":{"id":"toolu_01VQiNGRWBgBGs7TJjm5gSZP","name":"AskUserQuestion","input":{"questions":[{"header":"Colour","question":"Which colour should the banner be?","multiSelect":false,"options":[{"label":"Red","description":"warm"},{"label":"Blue (Recommended)","description":"cool"}]}]}}}
{"type":"system","subtype":"hook_started","hook_id":"844b21ee-3df9-4e88-88c6-e59ad90ffff5","hook_name":"PreToolUse:AskUserQuestion","hook_event":"PreToolUse","session_id":"290144af-729a-4195-b3ab-6cd584ef91e3"}
{"type":"system","subtype":"hook_response","hook_id":"844b21ee-3df9-4e88-88c6-e59ad90ffff5","hook_name":"PreToolUse:AskUserQuestion","hook_event":"PreToolUse","output":"{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"allow\",\"permissionDecisionReason\":\"spike listener: answered by hook\",\"updatedInput\":{\"questions\":[{\"question\":\"Which colour should the banner be?\",\"header\":\"Colour\",\"options\":[{\"label\":\"Red\",\"description\":\"warm\"},{\"label\":\"Blue (Recommended)\",\"description\":\"cool\"}],\"multiSelect\":false}],\"answers\":{\"Which colour should the banner be?\":\"Red\"}}}}","stdout":"{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"allow\",\"permissionDecisionReason\":\"spike listener: answered by hook\",\"updatedInput\":{\"questions\":[{\"question\":\"Which colour should the banner be?\",\"header\":\"Colour\",\"options\":[{\"label\":\"Red\",\"description\":\"warm\"},{\"label\":\"Blue (Recommended)\",\"description\":\"cool\"}],\"multiSelect\":false}],\"answers\":{\"Which colour should the banner be?\":\"Red\"}}}}","stderr":"","exit_code":200,"outcome":"success","session_id":"290144af-729a-4195-b3ab-6cd584ef91e3"}
{"type":"user","tool_result":{"tool_use_id":"toolu_01VQiNGRWBgBGs7TJjm5gSZP","content":"Your questions have been answered: \"Which colour should the banner be?\"=\"Red\". You can now continue with these answers in mind."}}
{"type":"assistant","text":"ANSWER=Red"}
{"type":"result","subtype":"success","stop_reason":"end_turn","terminal_reason":"completed","is_error":false,"num_turns":2,"total_cost_usd":0.0217432,"permission_denials":[],"result":"ANSWER=Red"}
```
- hook requests received by the listener (1), verbatim:
```jsonl
{"at":"2026-09-14T02:09:59.842Z","path":"/pretool","body":{"session_id":"290144af-729a-4195-b3ab-6cd584ef91e3","transcript_path":"~/.claude/projects/-private-tmp-claude-501--Users-<user>-work-pe-hub-7638d1f9-6d2a-4cf8-a3bf-39d12408a29e-scratchpad-spikes-cwd/290144af-729a-4195-b3ab-6cd584ef91e3.jsonl","cwd":"<spikes>/cwd","prompt_id":"75816333-8792-42c6-9d8b-66c25213999c","permission_mode":"default","hook_event_name":"PreToolUse","tool_name":"AskUserQuestion","tool_input":{"questions":[{"question":"Which colour should the banner be?","header":"Colour","options":[{"label":"Red","description":"warm"},{"label":"Blue (Recommended)","description":"cool"}],"multiSelect":false}]},"tool_use_id":"toolu_01VQiNGRWBgBGs7TJjm5gSZP"}}
```
- listener responses (HTTP 200, JSON):
```jsonl
{"at":"2026-09-14T02:09:59.842Z","path":"/pretool","reply":{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"spike listener: answered by hook","updatedInput":{"questions":[{"question":"Which colour should the banner be?","header":"Colour","options":[{"label":"Red","description":"warm"},{"label":"Blue (Recommended)","description":"cool"}],"multiSelect":false}],"answers":{"Which colour should the banner be?":"Red"}}}}}
```
- `--permission-prompt-tool` host: connected, **never called** for this arm's tool calls

