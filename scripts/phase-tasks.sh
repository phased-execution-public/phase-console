#!/usr/bin/env bash
# Publish this phase session's TASK LIST — the "what it is doing" panel's only
# reliable source.
#
# Usage: phase-tasks.sh <slug> <phase> reset
#        phase-tasks.sh <slug> <phase> create --subject TEXT [--id ID]
#                       [--status pending|in_progress|completed] [--active-form TEXT]
#        phase-tasks.sh <slug> <phase> update --id ID
#                       [--status pending|in_progress|completed|deleted]
#                       [--subject TEXT] [--active-form TEXT]
#
# WHY THIS EXISTS. Phase Console renders a session's task list live, folded from
# the CLI's own `TodoWrite` / `TaskCreate` / `TaskUpdate` calls. Around
# 2026-08-14 the CLI stopped provisioning those tools to `claude -p` sessions —
# measured over 946 machine transcripts: zero calls since. The pipeline was
# never broken; it was STARVED, and every unattended run since has shown an
# empty panel for hours while sessions burned tokens searching for a tool that
# was not there. A channel a session can be deprived of is not a channel. This
# one is a shell script, so the only way to take it away is to delete the file.
#
# THE WIRE FORMAT — a CONTRACT between this writer and `runner/tasks.ts`.
# One append-only NDJSON line per transition, compact, no spaces:
#
#   {"version":1,"type":"task","slug":"<slug>","phase":<int>,"op":"reset|create|update",
#    "id":"<id>","status":"<status>","subject":"<text>","active_form":"<text>",
#    "session_id":"<id>","written_at":"<ISO8601 Z>"}
#
# Field order is FIXED and load-bearing: `op` precedes every free-text field, so
# `op` can be read with an anchored match that no subject can forge (`slug` is
# sanitized to hold no quote, `phase` is a number). `reset` carries neither `id`
# nor `subject`. `id`, `status`, `active_form` and `session_id` are omitted when
# empty rather than written null — an absent key is how every other file in this
# protocol says "not stated".
#
# IDS ARE THE SESSION'S OWN, and that is the point. The CLI's `TaskCreate`
# returns its id in the tool RESULT, so a list could only be addressed after a
# round trip through a parser. Here the id is chosen at the create — `--id`, or
# `p<phase>.task<N>` derived from the creates since the last `reset`, which is
# exactly the `pN.taskM` convention SKILL.md already asks sessions to name their
# tasks by. A session can therefore write `update --id p8.task3 --status
# completed` with nothing read back and nothing remembered.
#
# WHERE IT GOES. `$PE_TASKS_FILE` when a runner is supervising (it injects the
# path and deletes it before every spawn, so a previous attempt's list can never
# speak for this one). Otherwise the console's own inbox for this repository —
#   ${XDG_STATE_HOME:-~/.local/state}/phase-console/runs/<instance>/<slug>/tasks/phase-NN.ndjson
# — the identity rule of viewer/shared/instances.mjs, mirrored in
# scripts/instance.sh, so a hand-driven session's list shows up on the run page
# beside an autopilot's. Either way the JSON is echoed to stdout, the path is
# named on stderr, and the exit is 0: a session following this discipline must
# never die here.
# Exit: 0 written/printed · 2 usage
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/instance.sh"

usage() {
  echo 'usage: phase-tasks.sh <slug> <phase> reset' >&2
  echo '       phase-tasks.sh <slug> <phase> create --subject TEXT [--id ID]' >&2
  echo '                      [--status pending|in_progress|completed] [--active-form TEXT]' >&2
  echo '       phase-tasks.sh <slug> <phase> update --id ID' >&2
  echo '                      [--status pending|in_progress|completed|deleted]' >&2
  echo '                      [--subject TEXT] [--active-form TEXT]' >&2
  exit 2
}

slug="${1:-}"; phase="${2:-}"; op="${3:-}"
[ -n "$slug" ] && [ -n "$phase" ] && [ -n "$op" ] || usage
shift 3

case "$phase" in ''|*[!0-9]*) echo "phase must be a number, got: $phase" >&2; exit 2 ;; esac
# The same normalisation phase-outcome.sh learned the hard way: `08` is
# all-digits and is NOT a legal JSON number, so an unquoted `08` in the number
# position makes the whole line unparseable and the reader discards it in
# silence. Sessions copy the padded number off their own handoff filename.
phase=$((10#$phase))

case "$op" in
  reset|create|update) : ;;
  *) echo "invalid op: $op (want reset|create|update)" >&2; exit 2 ;;
esac

# Same sanitizer as phase-outcome.sh, and for the same reason: control
# characters (a pasted newline most of all) would split one record into two
# unparseable halves of an NDJSON file.
_json_str() {
  printf '%s' "$1" | tr '\000-\037' ' ' | sed 's/\\/\\\\/g; s/"/\\"/g'
}

id=""; subject=""; status=""; active_form=""
while [ $# -gt 0 ]; do
  case "$1" in
    --id)          id="${2:?--id needs a value}"; shift 2 ;;
    --subject)     subject="${2:?--subject needs text}"; shift 2 ;;
    --status)      status="${2:?--status needs a word}"; shift 2 ;;
    --active-form) active_form="${2:?--active-form needs text}"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

# The four words are the vocabulary viewer/shared/task-model.js defines and the
# panel paints; `deleted` is a tombstone rather than a state, so it belongs to
# `update` alone — a task cannot be born deleted.
case "$status" in
  ''|pending|in_progress|completed) : ;;
  deleted)
    [ "$op" = update ] || { echo 'status "deleted" belongs to update, not create' >&2; exit 2; }
    ;;
  *) echo "invalid --status: $status (want pending|in_progress|completed$([ "$op" = update ] && echo '|deleted'))" >&2; exit 2 ;;
esac

case "$op" in
  reset)
    { [ -n "$id" ] || [ -n "$subject" ] || [ -n "$status" ] || [ -n "$active_form" ]; } \
      && { echo 'reset takes no options — it clears the list' >&2; exit 2; }
    ;;
  create)
    [ -n "$subject" ] || { echo '--subject is required for create (what the task is)' >&2; exit 2; }
    ;;
  update)
    [ -n "$id" ] || { echo '--id is required for update (which task changed)' >&2; exit 2; }
    { [ -n "$status" ] || [ -n "$subject" ] || [ -n "$active_form" ]; } \
      || { echo 'update needs one of --status / --subject / --active-form' >&2; exit 2; }
    ;;
esac

if [ -n "$id" ]; then
  # Ids address rows in a file and ride in a JSON string; anything outside this
  # set is either unquotable or unmatchable, and silently accepting it would
  # produce a row no update could ever name.
  case "$id" in
    *[!A-Za-z0-9._-]*) echo "invalid --id: $id (want A-Za-z0-9._- only)" >&2; exit 2 ;;
  esac
  id="$(printf '%s' "$id" | cut -c1-64)"
fi

subject="$(printf '%s' "$subject" | cut -c1-200)"
active_form="$(printf '%s' "$active_form" | cut -c1-200)"

now="${PE_NOW:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
session="${PE_SESSION_ID:-${CLAUDE_CODE_SESSION_ID:-}}"
session="$(printf '%s' "$session" | tr -cd 'A-Za-z0-9._-' | cut -c1-128)"

if [ -n "${PE_TASKS_FILE:-}" ]; then
  target="$PE_TASKS_FILE"
  supervised=yes
else
  root="$(pe_instance_root)"
  target="$(pe_runs_dir "$root" "$slug")/tasks/phase-$(printf '%02d' "$phase").ndjson"
  supervised=no
fi

# An unnamed create numbers itself from the creates SINCE THE LAST RESET, which
# is what makes `p8.task1` mean the same thing on a retry as it did the first
# time. Anchored at ^ so a subject that happens to contain `"op":"create"` is
# not counted: everything before `op` in the record is either a fixed literal, a
# sanitized slug (no quote can survive `_json_str`) or a number.
if [ "$op" = create ] && [ -z "$id" ]; then
  seen=0
  if [ -f "$target" ]; then
    seen="$(awk '
      /^\{"version":1,"type":"task","slug":"[^"]*","phase":[0-9]+,"op":"reset"/  { c = 0; next }
      /^\{"version":1,"type":"task","slug":"[^"]*","phase":[0-9]+,"op":"create"/ { c++ }
      END { print c + 0 }
    ' "$target" 2>/dev/null || echo 0)"
    case "$seen" in ''|*[!0-9]*) seen=0 ;; esac
  fi
  id="p${phase}.task$((seen + 1))"
fi

# `create` states its status so a reader never has to know a default; `update`
# states only what changed, because an absent key means "unchanged" and writing
# `pending` on every status-less update would silently un-complete tasks.
[ "$op" = create ] && [ -z "$status" ] && status=pending

id_json="$(          [ -n "$id" ]          && printf ',"id":"%s"' "$id" || true )"
status_json="$(      [ -n "$status" ]      && printf ',"status":"%s"' "$status" || true )"
subject_json="$(     [ -n "$subject" ]     && printf ',"subject":"%s"' "$(_json_str "$subject")" || true )"
active_json="$(      [ -n "$active_form" ] && printf ',"active_form":"%s"' "$(_json_str "$active_form")" || true )"
session_json="$(     [ -n "$session" ]     && printf ',"session_id":"%s"' "$session" || true )"

# The trace this session belongs to, as the console put it in the environment.
#
# A task list is written by a process the console let go of hours ago, and
# nothing afterwards can correlate it with the drive that started it — a task
# line and a journal line have nothing in common but a timestamp. So the id
# travels in the session's env and is written down here.
#
# `span` rides WITH `trace` and never without it: a span id alone points into a
# trace nobody named, which is half a join and reads like a whole one. And with
# neither set — an older console, a hand-driven session, a `claude` run from a
# terminal — the line is byte-identical to what it has always been.
trace="${PE_TRACE_ID:-}"
span="${PE_SPAN_ID:-}"
trace_json=''
if [ -n "$trace" ]; then
  trace_json="$(printf ',"trace":"%s"' "$(_json_str "$trace")")"
  [ -n "$span" ] && trace_json="${trace_json}$(printf ',"span":"%s"' "$(_json_str "$span")")"
fi

# ONE line. The file is NDJSON and a single short append is what makes a
# concurrent reader's tail safe: it either sees the whole record or none of it.
line="{\"version\":1,\"type\":\"task\",\"slug\":\"$(_json_str "$slug")\",\"phase\":$phase,\"op\":\"$op\"${id_json}${status_json}${subject_json}${active_json}${session_json}${trace_json},\"written_at\":\"$(_json_str "$now")\"}"

wrote=no
if mkdir -p "$(dirname "$target")" 2>/dev/null && printf '%s\n' "$line" >> "$target" 2>/dev/null; then
  wrote=yes
fi

if [ "$wrote" = yes ]; then
  if [ "$supervised" = yes ]; then
    case "$op" in
      reset)  echo "task list reset: $slug phase $phase  ->  $target" ;;
      *)      echo "task $op: $slug phase $phase ${id}  ->  $target" ;;
    esac
  else
    echo "note: PE_TASKS_FILE is not set (no runner is supervising this session) — recorded for the console at $target" >&2
    printf '%s\n' "$line"
  fi
else
  echo "note: $target could not be written — printing the task record only" >&2
  printf '%s\n' "$line"
fi
exit 0
