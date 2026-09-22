#!/usr/bin/env bash
# Session presence for Phase Console — a user-scope Claude Code hook.
#
# Installed (Settings ▸ Automation, or `phase-console install-hooks`) for
# SessionStart, SessionEnd, Stop and Notification, it tells the console that owns
# the session's working directory that a Claude session is live, still live,
# ended — or stopped waiting on a person (Notification fires when the CLI needs
# permission or sits idle waiting for input; its `message` rides along so the
# console can say WHAT is being waited on) — the
# channel an interactive `claude`, a console agent and an autopilot lane did not
# have: until now they could see each other only through lock files and leases.
# With it, a lock whose session has ENDED is debris the moment it ends, a lock
# whose session is live is a queue to wait in, and the Pulse shows the hand-run
# session beside the autopilot's lanes.
#
# Contract (bash 3.2, fail-open):
#   - reads the hook payload on stdin (bounded: 64 KiB), sed-grade extraction of
#     session_id · cwd · transcript_path · hook_event_name · source/reason
#     (both the field names this CLI sends and the documented ones are read),
#     plus `message` and `notification_type` — Notification only, so a Stop payload's quoted transcript
#     can never bleed in through first-occurrence extraction;
#   - resolves the REGISTERED console that owns the directory:
#       node <skill>/viewer/shared/instances.mjs owner --cwd "<cwd>"
#     (node looked for on PATH, then in Homebrew / /usr/local / volta / nvm) —
#     with no sole-instance fallback: "the only console" is not evidence a
#     directory belongs to it. A directory no registered console claims is
#     recorded `unowned`, with the project root it would have been and how the
#     answer was reached, in the machine's sink
#       <state home>/fleet/sessions/inbox/
#     rather than dropped or filed against the wrong console (FLT-8);
#   - POSTs {"version":1,"session_id",…} to <url>/hooks/session with a 2 s
#     timeout; when no console answers (or there is no node to ask), drops the
#     same record into the instance's inbox —
#       <instance state dir>/sessions/inbox/<at>-<session_id>-<event>.json
#     and, when node is there and the console refused the connection (not a
#     console that is up and slow), drains that inbox itself with
#     `phase-console sessions ingest` (REG-2) — in the background, except at
#     SessionStart, where it waits for the one line it needs;
#   - on SessionStart prints additionalContext naming the session id and the
#     `phase-lock.sh --session <id>` instruction, so a hand-driven session can
#     claim its lock as itself — and the other live sessions the registry
#     shows in the same repository (REG-3 iv), from the console's answer or the
#     drain's;
#   - ALWAYS exits 0. A hook that could stop a session would be a session
#     killed by a console's absence. Nothing here is load-bearing for safety.
# Set PHASE_CONSOLE_HOOK_OFF=1 to make it a no-op, PHASE_CONSOLE_HOOK_INGEST=0 to
# leave the inbox for the console.

# No `set -e`: every step is best effort and the exit is decided here.
set -u

[ "${PHASE_CONSOLE_HOOK_OFF:-}" = 1 ] && exit 0

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/instance.sh"

# ---- the payload -------------------------------------------------------------
input="$(head -c 65536 2>/dev/null || true)"
[ -n "$input" ] || exit 0

# _jget <key> → the FIRST occurrence's string value, unescaped; '' when absent.
# First occurrence matters: `last_assistant_message` (Stop) may quote a whole
# payload, and the fields this reads all precede it in the CLI's own output.
# BSD sed: no `\|`, so "non-specials, then (escape + non-specials)*".
_jget() { _jget_in "$input" "$1"; }
# _jget_in <json> <key> — the same, over any string (the console's answer).
_jget_in() {
  local rest="${1#*\"$2\"}"
  [ "$rest" != "$1" ] || { printf ''; return 0; }
  printf '%s' "$rest" \
    | sed -n 's/^[[:space:]]*:[[:space:]]*"\([^"\\]*\(\\.[^"\\]*\)*\)".*/\1/p' \
    | head -1 \
    | sed 's/\\\//\//g; s/\\"/"/g; s/\\\\/\\/g'
}

session_id="$(_jget session_id | tr -cd 'A-Za-z0-9._-' | cut -c1-128)"
event="$(_jget hook_event_name)"
cwd="$(_jget cwd)"
transcript="$(_jget transcript_path)"
source_="$(_jget source)";  [ -n "$source_" ] || source_="$(_jget session_start_reason)"
reason="$(_jget reason)";   [ -n "$reason" ]  || reason="$(_jget session_end_reason)"
# Notification only: the ask's own words, and WHICH ask it is. Guarded by event
# so another payload's `message`-shaped text is never mistaken for one.
#
# `notification_type` is the field that matters: the console used to sniff the
# message text for /permission/i because it had nothing else, so every hook
# event became a "session waiting on you" row and an urgent push — including
# the ones that are the CLI talking to itself. The registry maps only the three
# types that actually stop a session and ignores the rest.
message=""
notification_type=""
if [ "$(_jget hook_event_name)" = Notification ]; then
  message="$(_jget message | cut -c1-256)"
  notification_type="$(_jget notification_type | tr -cd 'a-z_' | cut -c1-64)"
fi

[ -n "$session_id" ] || exit 0
case "$event" in SessionStart|SessionEnd|Stop|Notification) : ;; *) exit 0 ;; esac
case "$cwd" in /*) : ;; *) cwd="$(pwd)" ;; esac

# ---- the owning console ------------------------------------------------------
# The same search viewer/run makes: PATH first, then the usual homes. No version
# floor here — instances.mjs is plain ESM and any node this decade runs it.
_find_node() { pe_find_node; }

# The console that minted this session says where its work-state lives, in
# `$DOCS_ROOT`. Asking the cwd instead is wrong for exactly the sessions that
# need it most: a lane session's cwd is a linked worktree, whose nearest
# project ancestor is the worktree — so its presence filed under a PHANTOM
# instance, the real console never saw the session, and every lock it held
# degraded to `presence:unknown`. Only an ABSOLUTE, existing value is trusted;
# a relative one would resolve against whatever directory the hook happens to
# run in, which is the same bug wearing a different hat.
docs_root=""
case "${DOCS_ROOT:-}" in /*) [ -d "$DOCS_ROOT" ] && docs_root="$DOCS_ROOT" ;; esac

url=""; state_dir=""; root=""; owner_kind=""; owner_how=""
node_bin="$(_find_node 2>/dev/null || true)"
if [ -n "$node_bin" ] && [ -f "$SKILL_DIR/viewer/shared/instances.mjs" ]; then
  if [ -n "$docs_root" ]; then
    shell_out="$("$node_bin" "$SKILL_DIR/viewer/shared/instances.mjs" owner --root "$docs_root" 2>/dev/null || true)"
  else
    shell_out="$("$node_bin" "$SKILL_DIR/viewer/shared/instances.mjs" owner --cwd "$cwd" 2>/dev/null || true)"
  fi
  owner_kind="$(printf '%s\n' "$shell_out" | sed -n 's/^kind=//p' | head -1)"
  owner_how="$(printf '%s\n' "$shell_out" | sed -n 's/^how=//p' | head -1)"
  root="$(printf '%s\n' "$shell_out" | sed -n 's/^root=//p' | head -1)"
  if [ "$owner_kind" = registered ]; then
    url="$(printf '%s\n' "$shell_out" | sed -n 's/^url=//p' | head -1)"
    state_dir="$(printf '%s\n' "$shell_out" | sed -n 's/^state_dir=//p' | head -1)"
  elif [ "$owner_kind" = unowned ]; then
    state_dir="$(printf '%s\n' "$shell_out" | sed -n 's/^inbox=//p' | head -1)"
    state_dir="${state_dir%/sessions/inbox}"
  fi
fi
if [ -z "$owner_kind" ]; then
  # No node, or it could not answer: the bash half of the same rule, read from
  # the REGISTRY rather than guessed from what exists on disk. `$DOCS_ROOT` is
  # taken as the root itself rather than searched upward from, because the
  # console named it; the cwd walk stays as the answer for a session nobody
  # minted. A root the registry does not hold — and a directory with no
  # project above it at all — is recorded in the machine's unowned sink.
  root="$docs_root"
  [ -n "$root" ] || root="$(pe_project_root_for "$cwd" 2>/dev/null || true)"
  if [ -n "$root" ] && state_dir="$(pe_registered_state_dir "$root")"; then
    owner_kind=registered; owner_how=no-node
  else
    owner_kind=unowned; owner_how=no-node
    unowned_inbox="$(pe_unowned_inbox)"
    state_dir="${unowned_inbox%/sessions/inbox}"
  fi
fi
[ -n "${PHASE_CONSOLE_URL:-}" ] && [ "$owner_kind" = registered ] && url="$PHASE_CONSOLE_URL"

# ---- the record --------------------------------------------------------------
_js() { printf '%s' "$1" | tr '\000-\037' ' ' | sed 's/\\/\\\\/g; s/"/\\"/g'; }
at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
# The drop's name carries MILLISECONDS (REG-7): two events of one kind for one
# session inside a second used to collide on a `date +%s` name. GNU date gives
# `%3N`; macOS date prints the letters back, and bash 3.2 has no EPOCHREALTIME,
# so the fallbacks are perl's clock, else seconds ×1000 with the pid as the
# tie-break — distinct names either way, and the registry never parses them.
epoch_ms="$(date +%s%3N 2>/dev/null)"
case "$epoch_ms" in
  *[!0-9]*|'') epoch_ms="$(perl -MTime::HiRes -e 'printf "%d", Time::HiRes::time()*1000' 2>/dev/null || printf '')" ;;
esac
case "$epoch_ms" in
  *[!0-9]*|'') epoch_ms="$(( $(date +%s) * 1000 ))" ;;
esac
user_="$(id -un 2>/dev/null || printf '')"
host_="$(hostname -s 2>/dev/null || hostname 2>/dev/null || printf '')"
# The claude process: Claude Code exports CLAUDE_PID to its hooks; the hook's
# own parent is that process too (verified), so $PPID is the fallback. The
# console uses it as a second liveness signal — a session whose process is
# gone has ended even when no SessionEnd ever arrived (a crash, a kill -9).
pid="${CLAUDE_PID:-${PPID:-0}}"
case "$pid" in ''|*[!0-9]*) pid=0 ;; esac
# The console's own MCP health probe sets PHASE_CONSOLE_PROBE=1 beside its
# PE_OWNER (console/mcp-probe): forwarded as a flag so the registry keeps the
# record, files it as the console's, and leaves it out of the operator's list.
probe_=0
[ "${PHASE_CONSOLE_PROBE:-}" = 1 ] && probe_=1
# Which Claude login the session spends, so a usage decision can count who else
# is on an account's window (autopilot-token-drain H6): the config dir the CLI
# reads its credentials from — unset is the CLI's own default, ~/.claude — and a
# FLAG when an environment credential outranks that dir. Never the credential.
config_dir="${CLAUDE_CONFIG_DIR:-${HOME:-}/.claude}"
auth_env_=0
[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}${ANTHROPIC_API_KEY:-}${ANTHROPIC_AUTH_TOKEN:-}${CLAUDE_CODE_USE_BEDROCK:-}${CLAUDE_CODE_USE_VERTEX:-}" ] && auth_env_=1
# How to reach this session's own CLI inbox, so the console can put a peer's
# message into it (5.1.0). Both variables are already exported when this hook
# runs — phase 1, arm S-B measured exactly that — and this is the ONLY way the
# console can learn either: the socket is /tmp/cc-socks/<the CLI's pid>.sock,
# which nothing outside the process knows, and the token is minted per session.
#
# SessionStart ONLY. A Stop or a Notification fires for a session whose socket
# may already be gone and the CLI does not re-export it, so carrying them there
# would teach the registry a stale path it would later connect to.
#
# The token is a SECRET: it goes in the POST body, which travels to 127.0.0.1
# over a loopback socket, and NEVER into the additionalContext line below —
# that line is printed into the session's own transcript, which is replayed into
# a browser and copied into bug reports.
messaging_socket=""
messaging_token=""
if [ "$event" = SessionStart ]; then
  messaging_socket="${CLAUDE_CODE_MESSAGING_SOCKET:-}"
  messaging_token="${CLAUDE_CODE_MESSAGING_TOKEN:-}"
fi
# The trace this session belongs to (5.1.0), so the presence record joins the
# drive that spawned it. The hook is the one thing that fires for EVERY session
# — the console's own, a reviewer's, a person's — and until now a session's
# arrival and its run could only be matched by cwd and clock. Always stated
# (empty when there is none), because the body is a fixed-shape object every
# field of which the registry reads positionally by name.
body="{\"version\":1,\"session_id\":\"$session_id\",\"event\":\"$(_js "$event")\",\"cwd\":\"$(_js "$cwd")\",\"transcript_path\":\"$(_js "$transcript")\",\"source\":\"$(_js "$source_")\",\"reason\":\"$(_js "$reason")\",\"owner\":\"$(_js "${PE_OWNER:-}")\",\"scope\":\"$(_js "${PE_SCOPE:-}")\",\"trace\":\"$(_js "${PE_TRACE_ID:-}")\",\"span\":\"$(_js "${PE_SPAN_ID:-}")\",\"user\":\"$(_js "$user_")\",\"host\":\"$(_js "$host_")\",\"pid\":$pid,\"root\":\"$(_js "$root")\",\"message\":\"$(_js "$message")\",\"notification_type\":\"$(_js "$notification_type")\",\"probe\":$probe_,\"config_dir\":\"$(_js "$config_dir")\",\"auth_env\":$auth_env_,\"messaging_socket\":\"$(_js "$messaging_socket")\",\"messaging_token\":\"$(_js "$messaging_token")\",\"owner_kind\":\"$(_js "$owner_kind")\",\"owner_how\":\"$(_js "$owner_how")\",\"at\":\"$at\"}"

# ---- deliver: POST to the console, else the inbox ------------------------------
delivered=0
curl_rc=""
answer=""
if [ -n "$url" ] && command -v curl >/dev/null 2>&1; then
  # A failed transfer is not delivery whatever it printed: curl's own exit
  # status is read first, then the HTTP code on the answer's last line. The
  # answer's body is kept: at SessionStart it names the other live sessions in
  # this repository (`peers`).
  nl='
'
  response="$(curl -sS -w "${nl}%{http_code}" --connect-timeout 1 --max-time 2 \
      -X POST "$url/hooks/session" -H 'content-type: application/json' -H 'x-phase-console: 1' \
      --data-binary "$body" 2>/dev/null)"
  curl_rc=$?
  code="${response##*"$nl"}"
  answer="${response%"$nl"*}"
  if [ "$curl_rc" = 0 ]; then
    case "$code" in 2[0-9][0-9]) delivered=1 ;; esac
  fi
fi
if [ "$delivered" = 0 ] && [ -n "$state_dir" ]; then
  inbox="$state_dir/sessions/inbox"
  if mkdir -p "$inbox" 2>/dev/null; then
    # 0600 like every other record (REG-7): the drop names the session, its
    # cwd and its transcript path.
    umask 077
    f="$inbox/$epoch_ms-$session_id-$event.json"
    # The same second, the same session, the same event: a distinct name, never
    # a silent overwrite — the pid is the tie-break.
    [ -e "$f" ] && f="$inbox/$epoch_ms-$session_id-$event-$$.json"
    tmp="$f.tmp.$$"
    # A hook killed between the write and the rename left a complete payload
    # matching no glob (REG-7): the trap takes the tmp with it, and the registry
    # reclaims any tmp whose pid is gone regardless.
    trap 'rm -f "$tmp" 2>/dev/null' EXIT
    if printf '%s\n' "$body" > "$tmp" 2>/dev/null; then mv "$tmp" "$f" 2>/dev/null || rm -f "$tmp" 2>/dev/null; fi
    trap - EXIT
  fi
fi

# ---- nobody drained it: drain it here (REG-2) ------------------------------------
# The inbox's only reader used to be a running console, so for the whole of an
# outage every drop waited — and a boot replayed hours of them as news. When the
# console REFUSED the connection (curl 7, or nothing to POST to) and node is
# here, the verb drains it now, through the registry's own code, and stops at
# once if the instance's console turns out to be up. A console that timed out
# (curl 28) is up and slow, and drains its own. At SessionStart the drain is
# waited for, because the new session's context wants the one line it prints;
# every other event leaves it running in the background and returns.
peers=""
if [ "$delivered" = 1 ] && [ "$event" = SessionStart ]; then
  peers="$(_jget_in "$answer" peers)"
elif [ "$delivered" = 0 ] && [ "$owner_kind" = registered ] && [ "$curl_rc" != 28 ] && [ -n "$node_bin" ] && [ -n "$root" ] \
    && [ "${PHASE_CONSOLE_HOOK_INGEST:-1}" != 0 ] && [ -f "$SKILL_DIR/bin/phase-console.mjs" ]; then
  if [ "$event" = SessionStart ]; then
    peers="$("$node_bin" "$SKILL_DIR/bin/phase-console.mjs" sessions ingest --root "$root" --quiet --peers-of "$session_id" 2>/dev/null \
      | sed -n 's/^peers=//p' | head -1)"
  else
    ( "$node_bin" "$SKILL_DIR/bin/phase-console.mjs" sessions ingest --root "$root" --quiet >/dev/null 2>&1 </dev/null & ) 2>/dev/null
  fi
fi

# ---- what the session is told ---------------------------------------------------
# Only at SessionStart, and only for a directory a console owns or could own —
# a shell in an unrelated directory is not told about phase locks.
if [ "$event" = SessionStart ] && [ -n "$root" ]; then
  if [ -n "${PE_SESSION_ID:-}" ]; then
    how="PE_SESSION_ID is already exported for this session, so scripts/phase-lock.sh records it by itself."
  else
    how="When you claim a phase lock by hand, pass it: scripts/phase-lock.sh <slug> claim <N> ... --session $session_id (or export PE_SESSION_ID=$session_id)."
  fi
  ctx="Phase Console session presence: this Claude session's id is $session_id. $how That lets the console show this session on the Pulse, queue autopilot lanes behind it while it lives, and release its lock the moment it ends."
  # Naming the peers was only half the sentence. A session that has been told
  # another is live still has no way to know whether their WORKING TREES
  # collide — a different question, answered by a read-only scan that costs one
  # command and looks across EVERY plan, because a working tree does not know
  # which plan asked for it. Without this line the thing a fresh session
  # actually acted on was "somebody else is here, carry on", which is how a
  # hand-driven session came to be told "safe to start" against a console lane
  # that had been granted and not yet claimed (S1-a's other half).
  if [ -n "$peers" ]; then
    ctx="$ctx $(printf '%s' "$peers" | cut -c1-1200)"
    ctx="$ctx Before you claim a phase, check that nothing live shares your working tree: scripts/phase-lock.sh <slug> conflicts <N> --scope \"<csv>\" --here — exit 0 is clear, 1 names the holders. Never build over a live session."
  fi
  printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$(_js "$ctx")"
fi
exit 0
