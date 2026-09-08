#!/usr/bin/env bash
# Declare a phase session's machine-readable OUTCOME — the record the autopilot
# reads instead of guessing from prose. Born from a live failure: a session that
# had done real work ended its turn "waiting on the image build (34-65 min)" in
# free text, the runner read the clean exit as completion, found no handoff, and
# halted the run. Prose has no parser; this file does.
#
# Usage: phase-outcome.sh <slug> <phase> <status> [--reason TEXT] [--watch REF]...
#                         [--wait-minutes N | --until ISO8601]
#        phase-outcome.sh <slug> <phase> ruling --what TEXT [--why TEXT]
#                         [--kind ambiguity|deviation|deferral] [--cost-if-wrong TEXT]
#   status: complete | waiting-external | blocked | needs-human | partial | no-defect
#   no-defect "I looked, and there was nothing to fix" — the REPAIR family's
#             word, declared by a session the console sent to mend one specific
#             thing that turned out to be already mended. Neither `complete`
#             (it fixed nothing) nor a failure (nothing was wrong); it settles
#             the ladder rung `no-defect` instead of blaming it for the absence
#             of a defect.
#   partial   "work remains, resume me" — declared when the session must stop
#             before the exit criteria without anything being wrong (its
#             budget, its context); the runner resumes the session instead of
#             reading the clean exit as a failed phase. --reason conventionally
#             names why: budget | context | other
#   --wait-minutes / --until  only with a status that PARKS — waiting-external,
#                             blocked, needs-human (absent -> the runner's
#                             default window); mutually exclusive. On blocked
#                             and needs-human it does not replace the ask: the
#                             errand still stands, the clock only says when the
#                             console next brings the phase up.
#   --watch   repeatable (max 8); free-form refs. The console polls these on its
#             own timer (viewer/server/watch-scheduler.ts) and resumes THIS
#             session when one lands:
#             gh:<repo>#run/<id>   the run reaches `completed`, any conclusion
#             gh:<repo>#pr/<n>     the PR leaves OPEN (merged or closed)
#             date:<ISO8601>       that instant passes  (`until:` is the same scheme)
#             lock:<slug>/<phase>  nothing holds that phase's scope any more
#             cmd:"<command>"      the command exits 0 — run under the same
#                                  read-only policy a plan's §Verification gets,
#                                  60 s, and refusable by the operator's
#                                  `watchCmdRefs` switch
#
# `ruling` is not a status and never becomes one: the six statuses above say
# how a session ENDED and the runner acts on each; a ruling says what a session
# DECIDED on the way, and nothing acts on it at all. That is what makes it safe
# to record whenever you are in doubt — it costs one line and it buys the next
# session a reader. It appends ONE NDJSON line to $PE_RULINGS_FILE (the runner
# injects it) or, unsupervised, to
#   <state>/phase-console/runs/<instance id>/<slug>/rulings.ndjson
# beside the outcomes/ inbox. Append-only: the console folds acks in as further
# lines rather than rewriting the file under a live session. Declaring a ruling
# does not declare an outcome — do both.
#
# Writes ONE atomic JSON file to $PE_OUTCOME_FILE (tmp+mv) — the runner injects
# that path into every session it supervises and consumes the file on exit.
# Without $PE_OUTCOME_FILE (no runner supervising this session) the file goes to
# the console's own inbox for this repository instead —
#   ${XDG_STATE_HOME:-~/.local/state}/phase-console/runs/<instance id>/<slug>/outcomes/phase-NN.json
# (the identity rule of viewer/shared/instances.mjs, mirrored in scripts/instance.sh) —
# where Phase Console's convergence loop picks it up: a human session's declared
# wait, block or partial drives the same machinery as a supervised one's. The JSON
# is still printed to stdout, the path is named on stderr, and the exit is 0: an
# interactive session following the same discipline must not die here, and the
# runner-side check — not this script — is the load-bearing enforcement.
# The session id rides along as "session_id" when the session knows it
# ($PE_SESSION_ID, runner-injected; else $CLAUDE_CODE_SESSION_ID, which Claude
# Code exports to its own subprocesses) so the console can resume THAT session.
# Exit: 0 written/printed · 2 usage
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/instance.sh"

usage() {
  echo 'usage: phase-outcome.sh <slug> <phase> <complete|waiting-external|blocked|needs-human|partial|no-defect>' >&2
  echo '                        [--reason TEXT] [--watch REF]... [--wait-minutes N | --until ISO8601]' >&2
  echo '   --wait-minutes/--until: waiting-external | blocked | needs-human' >&2
  echo '   --watch schemes: gh:<repo>#run/<id> · gh:<repo>#pr/<n> · date:<ISO> · lock:<slug>/<phase> · cmd:"<command>"' >&2
  echo '       phase-outcome.sh <slug> <phase> ruling --what TEXT [--why TEXT]' >&2
  echo '                        [--kind ambiguity|deviation|deferral] [--cost-if-wrong TEXT]' >&2
  exit 2
}

slug="${1:-}"; phase="${2:-}"; status="${3:-}"
[ -n "$slug" ] && [ -n "$phase" ] && [ -n "$status" ] || usage
shift 3

case "$phase" in ''|*[!0-9]*) echo "phase must be a number, got: $phase" >&2; exit 2 ;; esac
# `08` passes the all-digits test and then goes UNQUOTED into the JSON number
# position, where it is not a legal JSON number at all: the runner's readOutcome
# throws, catches, and returns null — which it documents as "the session declared
# nothing". So a session that correctly parked itself, using the padded number it
# read off its own handoff filename, had the park silently dropped and the run
# halted instead. It also broke the unsupervised path's `printf '%02d'`.
phase=$((10#$phase))
mode=outcome
case "$status" in
  complete|waiting-external|blocked|needs-human|partial|no-defect) : ;;
  ruling) mode=ruling ;;
  *) echo "invalid status: $status (want complete|waiting-external|blocked|needs-human|partial|no-defect, or ruling)" >&2; exit 2 ;;
esac

# JSON string sanitizer, bash 3.2 + BSD sed: control chars (newlines included)
# become spaces, then backslash and quote are escaped. Defined before the arg
# loop because --watch builds its JSON inline (bash 3.2 has no arrays worth
# passing around, so the refs are folded as they arrive).
_json_str() {
  printf '%s' "$1" | tr '\000-\037' ' ' | sed 's/\\/\\\\/g; s/"/\\"/g'
}

reason=""; wait_minutes=""; until_iso=""
watch_count=0; watch_json=""
what=""; why=""; kind=""; cost=""
while [ $# -gt 0 ]; do
  case "$1" in
    --reason)       reason="${2:?--reason needs text}"; shift 2 ;;
    --what)         what="${2:?--what needs text}"; shift 2 ;;
    --why)          why="${2:?--why needs text}"; shift 2 ;;
    --kind)         kind="${2:?--kind needs a word}"; shift 2 ;;
    --cost-if-wrong) cost="${2:?--cost-if-wrong needs text}"; shift 2 ;;
    --wait-minutes) wait_minutes="${2:?--wait-minutes needs a number}"; shift 2 ;;
    --until)        until_iso="${2:?--until needs an ISO8601 time}"; shift 2 ;;
    --watch)
      ref="${2:?--watch needs a ref}"
      if [ "$watch_count" -lt 8 ]; then
        ref="$(printf '%s' "$ref" | cut -c1-200)"
        watch_json="${watch_json:+$watch_json, }\"$(_json_str "$ref")\""
        watch_count=$((watch_count + 1))
      else
        echo "ignoring --watch beyond the 8th: $ref" >&2
      fi
      shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

# The two shapes share one option loop and are then held apart, so a flag that
# belongs to the other one is an error rather than a silent no-op.
if [ "$mode" = ruling ]; then
  if [ -n "$reason" ] || [ -n "$wait_minutes" ] || [ -n "$until_iso" ] || [ "$watch_count" -gt 0 ]; then
    echo '--reason/--watch/--wait-minutes/--until belong to an outcome status, not to a ruling' >&2; exit 2
  fi
  [ -n "$what" ] || { echo '--what is required for a ruling (say what you decided)' >&2; exit 2; }
  # Absent means the weakest of the three: a session that simply chose between
  # two readings has not deviated from anything, and recording it as a
  # deviation would put a disagreement in the ledger that never happened.
  [ -n "$kind" ] || kind=ambiguity
  case "$kind" in ambiguity|deviation|deferral) : ;; *)
    echo "invalid --kind: $kind (want ambiguity|deviation|deferral)" >&2; exit 2 ;; esac
elif [ -n "$what" ] || [ -n "$why" ] || [ -n "$kind" ] || [ -n "$cost" ]; then
  echo "--what/--why/--kind/--cost-if-wrong only make sense with ruling, not $status" >&2; exit 2
fi

if [ -n "$wait_minutes" ] && [ -n "$until_iso" ]; then
  echo '--wait-minutes and --until are mutually exclusive' >&2; exit 2
fi
# The clock belongs to the three statuses that PARK. `complete` has nothing to
# resume and `partial` is resumed at once, so a clock on either is a session
# describing a wait it is not taking — refused rather than silently dropped.
#
# `blocked` and `needs-human` were refused here until 2026-08-30, and the
# refusal cost more than it saved: a session can know both that a person must
# look AND that there is no point looking before the release lands. Forced to
# choose it chose the question, and the clock — the one fact that could have
# moved the phase without anybody — was discarded at the parser. The ask stands
# either way; the clock only decides when the console next brings it up.
case "$status" in
  waiting-external|blocked|needs-human) : ;;
  *)
    if [ -n "$wait_minutes" ] || [ -n "$until_iso" ]; then
      echo "--wait-minutes/--until only make sense with a status that parks (waiting-external, blocked, needs-human), not $status" >&2
      exit 2
    fi
    ;;
esac
if [ -n "$wait_minutes" ]; then
  case "$wait_minutes" in ''|*[!0-9]*) echo "--wait-minutes must be a number, got: $wait_minutes" >&2; exit 2 ;; esac
fi
if [ -n "$until_iso" ]; then
  # Glob patterns, not a regex: bash 3.2 has no `[[ =~ ]]` worth relying on
  # across the macOS/Linux split this script runs on, and `case` is POSIX. Both
  # separators are accepted because `date:` refs are written by hand as often as
  # by `--wait-minutes`, and "2026-08-30 09:00" is what a person types.
  case "$until_iso" in
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]*) : ;;
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]" "[0-9][0-9]:[0-9][0-9]*) : ;;
    *) echo "--until must be ISO8601 (YYYY-MM-DDTHH:MM...), got: $until_iso" >&2; exit 2 ;;
  esac
  # Shape is not sense. `2026-13-45T99:99` matches every glob above and is not a
  # moment; a park armed from one resumes immediately or never, and both look
  # like a console bug rather than a typo three files away.
  _mm="$(printf '%s' "$until_iso" | cut -c6-7)"
  _dd="$(printf '%s' "$until_iso" | cut -c9-10)"
  _hh="$(printf '%s' "$until_iso" | cut -c12-13)"
  _mi="$(printf '%s' "$until_iso" | cut -c15-16)"
  _yy="$(printf '%s' "$until_iso" | cut -c1-4)"
  # Days in THIS month, not a flat 31. `2026-09-31` passed the flat bound and
  # the consumers use a bare `Date.parse`, which rolls it over to October 1st —
  # so the phase parked a day later than the session asked with nothing anywhere
  # saying why, which is verbatim the defect this check exists to prevent (QA F6).
  case "$((10#$_mm))" in
    1|3|5|7|8|10|12) _max=31 ;;
    4|6|9|11)        _max=30 ;;
    2) if [ $(( (10#$_yy % 4 == 0 && 10#$_yy % 100 != 0) || 10#$_yy % 400 == 0 )) -eq 1 ]
       then _max=29; else _max=28; fi ;;
    *) _max=0 ;;
  esac
  if [ "$((10#$_mm))" -lt 1 ] || [ "$((10#$_mm))" -gt 12 ] \
    || [ "$((10#$_dd))" -lt 1 ] || [ "$((10#$_dd))" -gt "$_max" ] \
    || [ "$((10#$_hh))" -gt 23 ] || [ "$((10#$_mi))" -gt 59 ]; then
    echo "--until is not a real instant: $until_iso" >&2; exit 2
  fi
fi

# Reason is capped so a pasted log cannot bloat the record the runner
# journals verbatim.
reason="$(printf '%s' "$reason" | cut -c1-500)"

# PE_NOW pins the clock for tests (same idea as PE_TODAY in gate-approve.sh).
now="${PE_NOW:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"

# Read once, above both shapes: an outcome names the session so the console can
# resume it, and a ruling names it so a reader can find the transcript the
# decision was made in.
session="${PE_SESSION_ID:-${CLAUDE_CODE_SESSION_ID:-}}"
session="$(printf '%s' "$session" | tr -cd 'A-Za-z0-9._-' | cut -c1-128)"

# ---- ruling: one appended NDJSON line, and nothing else happens ------------
# Deliberately before the outcome machinery rather than folded into it: a
# ruling has no resume clock, no watch refs and no consumer, and threading it
# through code that exists to arm one would be four `if`s to reach the same
# `>>`.
if [ "$mode" = ruling ]; then
  what="$(printf '%s' "$what" | cut -c1-500)"
  why="$(printf '%s' "$why" | cut -c1-800)"
  cost="$(printf '%s' "$cost" | cut -c1-300)"
  why_json="$( [ -n "$why" ] && printf ',"why":"%s"' "$(_json_str "$why")" || true )"
  cost_json="$( [ -n "$cost" ] && printf ',"cost_if_wrong":"%s"' "$(_json_str "$cost")" || true )"
  session_json="$( [ -n "$session" ] && printf ',"session_id":"%s"' "$session" || true )"
  # ONE line: the file is NDJSON and a pretty-printed record would make every
  # reader a parser with state.
  line="{\"version\":1,\"type\":\"ruling\",\"slug\":\"$(_json_str "$slug")\",\"phase\":$phase,\"kind\":\"$kind\",\"what\":\"$(_json_str "$what")\"${why_json}${cost_json}${session_json},\"at\":\"$(_json_str "$now")\"}"

  if [ -n "${PE_RULINGS_FILE:-}" ]; then
    ledger="$PE_RULINGS_FILE"
    if mkdir -p "$(dirname "$ledger")" 2>/dev/null && printf '%s\n' "$line" >> "$ledger" 2>/dev/null; then
      echo "ruling recorded: $slug phase $phase ($kind)  ->  $ledger"
    else
      echo "note: $ledger could not be written — printing the ruling only" >&2
      printf '%s\n' "$line"
    fi
  else
    root="$(pe_instance_root)"
    ledger="$(pe_runs_dir "$root" "$slug")/rulings.ndjson"
    if mkdir -p "$(dirname "$ledger")" 2>/dev/null && printf '%s\n' "$line" >> "$ledger" 2>/dev/null; then
      echo "note: PE_RULINGS_FILE is not set (no runner is supervising this session) — recorded for the console at $ledger" >&2
    else
      echo "note: PE_RULINGS_FILE is not set and $ledger could not be written — printing the ruling only" >&2
    fi
    printf '%s\n' "$line"
  fi
  exit 0
fi

resume_after=""
if [ "$status" = waiting-external ] || [ "$status" = blocked ] || [ "$status" = needs-human ]; then
  if [ -n "$until_iso" ]; then
    # Normalised to the `T` form on the way out, so every consumer sees one
    # spelling. A space is accepted at the door because that is what a person
    # types; it is not a second wire format.
    resume_after="$(printf '%s' "$until_iso" | tr ' ' 'T')"
  elif [ -n "$wait_minutes" ]; then
    # BSD date first (macOS system bash pairs with BSD date), GNU as fallback.
    resume_after="$(date -u -v"+${wait_minutes}M" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
      || date -u -d "+${wait_minutes} minutes" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true)"
  fi
fi

# Optional fields render as whole lines or not at all; the `|| true` keeps a
# skipped field from failing the assignment under `set -e` (an assignment's
# exit status is its last command substitution's).
reason_line="$( [ -n "$reason" ] && printf '\n  "reason": "%s",' "$(_json_str "$reason")" || true )"
resume_line="$( [ -n "$resume_after" ] && printf '\n  "resume_after": "%s",' "$(_json_str "$resume_after")" || true )"
session_line="$( [ -n "$session" ] && printf '\n  "session_id": "%s",' "$session" || true )"

json="{
  \"version\": 1,
  \"slug\": \"$(_json_str "$slug")\",
  \"phase\": $phase,
  \"status\": \"$status\",${reason_line}${resume_line}${session_line}
  \"watch\": [$watch_json],
  \"written_at\": \"$(_json_str "$now")\"
}"

if [ -n "${PE_OUTCOME_FILE:-}" ]; then
  # The unsupervised branch below has always degraded honestly — mkdir, and on
  # failure print the JSON and exit 0, exactly as this script's header promises.
  # The supervised branch had no guard at all: a PE_OUTCOME_FILE whose parent
  # does not exist made the redirect fail, set -e fired, and the session died
  # with exit 1 and NOTHING on either stream — the one failure mode a channel
  # built to replace prose must not have. Same promise, both branches.
  tmp="$PE_OUTCOME_FILE.tmp.$$"
  mkdir -p "$(dirname "$PE_OUTCOME_FILE")" 2>/dev/null || true
  # A subshell, so the SHELL's own "No such file or directory" for a redirect it
  # cannot open is suppressed too — that message is the shell's, not printf's.
  if ( printf '%s\n' "$json" > "$tmp" ) 2>/dev/null && mv "$tmp" "$PE_OUTCOME_FILE" 2>/dev/null; then
    echo "outcome recorded: $slug phase $phase = $status  ->  $PE_OUTCOME_FILE"
  else
    rm -f "$tmp" 2>/dev/null || true
    echo "note: PE_OUTCOME_FILE ($PE_OUTCOME_FILE) could not be written — printing the outcome only" >&2
    printf '%s\n' "$json"
  fi
else
  # Unsupervised: the console's inbox for this repository. Best-effort — a state
  # home that cannot be written (read-only HOME, no HOME at all) still leaves
  # the JSON on stdout for whoever is reading, and the exit stays 0.
  root="$(pe_instance_root)"
  inbox="$(pe_runs_dir "$root" "$slug")/outcomes"
  target="$inbox/phase-$(printf '%02d' "$phase").json"
  if mkdir -p "$inbox" 2>/dev/null; then
    tmp="$target.tmp.$$"
    if printf '%s\n' "$json" > "$tmp" 2>/dev/null && mv "$tmp" "$target" 2>/dev/null; then
      echo "note: PE_OUTCOME_FILE is not set (no runner is supervising this session) — recorded for the console at $target" >&2
    else
      rm -f "$tmp" 2>/dev/null || true
      echo "note: PE_OUTCOME_FILE is not set and $target could not be written — printing the outcome only" >&2
    fi
  else
    echo "note: PE_OUTCOME_FILE is not set and $inbox could not be created — printing the outcome only" >&2
  fi
  printf '%s\n' "$json"
fi
exit 0
