# Probe — the CLI's cross-session inbox socket, measured from a `claude -p` session's own position

cli: 2.1.274
node: v24.13.1
date: 2026-09-18
verdict: usable-with-accept
cost_usd: 0.31 (six haiku receivers, each capped at `--max-budget-usd 0.10`)
settles: `many-plans-one-repo` phase 1 arms S-A…S-F — the premises phase 10 (messaging core) is built on

**Why this exists.** Decision 14 of the plan assumed the console could post into a session's inbox *past* a
`crossSessionInbound: hold`, because the console holds that session's own `CLAUDE_CODE_MESSAGING_TOKEN` and
so counts as an "own child". **It cannot.** Every other premise held. The one that did not is the one that
decides phase 10's design, so it is the first row of the table.

| arm | what was asked | verdict | what phase 10 must therefore assume |
|---|---|---|---|
| `S-A` | does a `claude -p --input-format stream-json` session bind an inbox socket? | bound | every phase session is addressable; no flag needed |
| `S-B` | what does the hook see, and what is the wire frame? | both | the `SessionStart` hook sees socket **and** token; the frame is two NDJSON lines |
| `S-C` | does a token-authenticated write bypass an explicit `hold`? | no | **phase 10 must ship `accept` + the mark rule** — the own-child exception does not reach an explicit setting |
| `S-D` | mid-tool or between turns? | between-tool-calls | a running tool is never interrupted; a message posted mid-`Bash` is read after that call's result |
| `S-E` | what does the receiver print? | replay-only | the text appears on stdout **only** with `--replay-user-messages`, as `origin.kind === "peer"` |
| `S-F` | is a rapid burst refused at the inbox? | no-refusal | the socket takes a flood; **the console must impose its own budget** |

**The exact frame, from the CLI's own `--debug-file`** (it prints its recipe at startup):

```
[uds-messaging] Inject messages (auth line optional here): { echo '{"type":"auth","token":"'"$CLAUDE_CODE_MESSAGING_TOKEN"'"}'; echo '{"type":"user","message":{"role":"user","content":"hello"}}'; } | socat - UNIX-CONNECT:<socket>
[uds-messaging] Connect when the data is ready (e.g. out=$(cmd); printf '%s\n' "$out" | nc -U "$CLAUDE_CODE_MESSAGING_SOCKET" — or the socat form above): a connection that sends no complete line within 30000 ms is closed
```

`content` is a **string**. Three shapes that look right are refused, each with its own log line —
`{"type":"user","content":"…"}` and a `content` array of blocks both draw *"Ignoring user message with
missing or non-string content"*, and `peer_message` / `message` draw *"Received unhandled message type"*.
Getting this wrong is silent on the wire: **the inbox never writes a byte back** (`REPLY_BYTES=0` on every
arm, accepted or refused), so a poster learns nothing from the connection and must read the receiver's own
stream to know what happened.

## S-A — the socket

A receiver spawned as
`claude -p --input-format stream-json --output-format stream-json --verbose --model haiku --max-turns 6
--max-budget-usd 0.10 --setting-sources project --permission-mode bypassPermissions --settings <file>
--session-id <uuid>`, stdin a FIFO held open, bound `/tmp/cc-socks/<pid>.sock` — `srw-------`, in a `0700`
directory, where `<pid>` is the CLI's own process id. Six of six receivers bound one.

## S-B — what the hook sees

A `SessionStart` hook in the receiver's `--settings` wrote its environment out. Both variables were already
exported when it ran:

```
socket=/tmp/cc-socks/<pid>.sock
token=<32 lowercase hex>
```

That is the whole of phase 10's capture: the hook is enough, and it fires before the session's first turn.

## S-C — the one that was wrong

Two receivers, identical but for one settings key, each sent the same token-authenticated frame from a
**sibling** process (not a descendant — the console's actual position), while each was mid-`Bash`:

| receiver `--settings` | permission mode | marker in the final answer | verdict |
|---|---|---|---|
| `"crossSessionInbound": "accept"` | `bypassPermissions` | `DONE ALPHA` | delivered |
| `"crossSessionInbound": "hold"` | `bypassPermissions` | `DONE` | held, then dropped |

The held receiver printed exactly two lines about it, and nothing else:

```json
{"type":"system","subtype":"peer_message_hold","state":"held","message_uuid":"…","lane":"socket","from":"","cause":"explicit-setting"}
{"type":"system","subtype":"peer_message_hold","state":"dropped","message_uuid":"…","lane":"socket","from":"","outcome":"discarded"}
```

`cause: "explicit-setting"` is the finding. The documented own-child exception is conditioned on *no*
`crossSessionInbound` value applying; a value from `--settings` applies, so the token buys nothing. The
`accept` arm is the control that makes this a measurement rather than a broken poster: the same bytes, the
same sender, delivered.

**The consequence for phase 10, stated plainly:** the console must write `crossSessionInbound: "accept"`
into each phase session's `--settings` and take responsibility for what reaches the session itself — the
mark rule — because there is no setting under which the CLI both holds peers *and* lets the console through.

## S-D — when a delivered message is read

Posted 26 ms after the receiver's `Bash` call started (`sleep 22`). The stream shows `task_started`, then
`task_notification … "status":"completed"`, then the `tool_result`, and only then an assistant turn carrying
the marker. The running tool was not interrupted and the turn was not restarted.

## S-E — what a watching console can see

Without `--replay-user-messages` the delivered text appears **nowhere** in the receiver's stdout — the model
plainly read it (it answered `DONE ALPHA`) but no line carried the words. With the flag — which
`buildArgv` already passes on every console-spawned session — it arrives in full:

```json
{"type":"user","message":{"role":"user","content":"…"},"session_id":"…","parent_tool_use_id":null,
 "uuid":"…","timestamp":"…","isReplay":true,"isSynthetic":true,
 "origin":{"kind":"peer","from":"unknown","verifiedPeerPid":90400}}
```

`origin.kind === "peer"` is the discriminator; `verifiedPeerPid` is the posting process the CLI verified.
`from` is `"unknown"` because a raw socket poster asserts no sender identity — phase 10 should expect to put
its own name there, or accept `unknown` and carry the sender in the body.

## S-F — the burst

Fifteen distinct bodies written back to back on one connection, no delay. The debug log recorded
`[uds-messaging] Routed user message to queue (priority=next)` **fifteen times**, and fifteen `origin.kind =
"peer"` lines reached stdout. Nothing was refused and nothing was dropped.

The burst refusal the documentation describes lives in the `SendMessage` **tool**, in the sending session —
not on the socket. A console posting directly is not subject to it, which is why the plan's per-phase and
per-run message budgets are not belt-and-braces but the only limit there is.

## What this fixture does not establish

The cross-machine path (Remote Control), the `SendMessage` tool's own refusals, `dialogExpiry` on a
default-held message, and the 50-message queue cap — none were exercised. `from` was never populated,
because nothing here sent as a named session.
