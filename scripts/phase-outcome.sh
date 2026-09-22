#!/usr/bin/env bash
# Declare a phase session's machine-readable OUTCOME — the record the autopilot
# reads instead of guessing from prose. Born from a live failure: a session that
# had done real work ended its turn "waiting on the image build (34-65 min)" in
# free text, the runner read the clean exit as completion, found no handoff, and
# halted the run. Prose has no parser; this file does.
#
# Usage: phase-outcome.sh <slug> <phase> <status> [--reason TEXT] [--watch REF]...
#                         [--wait-minutes N | --until ISO8601]
#                         [--needs KEY] [--rule TEXT] [--command TEXT]
#        phase-outcome.sh <slug> <phase> ruling --what TEXT [--why TEXT]
#                         [--kind ambiguity|deviation|deferral] [--cost-if-wrong TEXT]
#                         [--needs KEY] [--remember plan|global]
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
#   --needs   REQUIRED on blocked and needs-human (exit 2 without it), refused on
#             the rest: the decision KEY the session is missing — one of the
#             manifest's seventeen (scripts/decisions.env DECISION_KEYS) or a
#             blocker class as its short form (NEED_CLASSES: lock permission
#             credential gate external). Read by the runner BEFORE the prose
#             (chapter 10 ZTD-3): `blocked-declared:unknown` then means "a key
#             the manifest lacks", a defect report, not 39 % of asks.
#   --rule / --command  optional structured fields for a permission block —
#             the rule that refused and the command it refused — beside --needs.
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
#   Every ruling line carries an "id" — sha256("<slug> <phase> <at> <what>")
#   cut to 12 hex, the same bytes viewer/server/runner/rulings.ts derives, so
#   the ledger's ack lines, the inbox row and `decisions.sh promote` all name
#   one ruling by one id.
#   --needs KEY  optional on a ruling: the decision KEY the ruling answers (one
#             of DECISION_KEYS, never a blocker short form — a ruling is not a
#             blocker), stamped as "decisionKey". A keyed ruling is what the
#             console's inbox offers to remember, and what --remember needs.
#   --remember plan|global  promote the ruling the moment it is recorded
#             (chapter 10 ZTD-7 — 2 315 rulings once reached no plan and no
#             default). `plan` writes a `## Decisions` row for its key into
#             docs/handoffs/<slug>/decisions.md through decisions.sh promote
#             (source: ruling, value: --what, evidence: the id), then acks the
#             ruling in the ledger with --by. `global` asks the console that
#             owns this repository to set its own `policy.<key>` answer — the
#             same door the inbox's "Remember on this console" action uses,
#             POST /api/run/<slug>/rulings/<id>/remember — so --what must be an
#             answer word for the key (the console names the words when it is
#             not); with no console answering, exit 1 and the Settings page
#             named, nothing dropped silently.
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
# The decision manifest's vocabulary — the OWNER is viewer/shared/decisions-model.js,
# decisions.env its bash twin (held equal by viewer/test/decisions-model.test.ts).
DECISION_KEYS="permission.policy permission.destructive issues credentials accounts mcp gates verification.person-check qa.exhausted waits human-acts ambiguity budgets resume.on-restart plan-health stop relay announce"
NEED_CLASSES="lock permission credential gate external"
# shellcheck source=/dev/null
[ -f "$SCRIPT_DIR/decisions.env" ] && . "$SCRIPT_DIR/decisions.env"

usage() {
  echo 'usage: phase-outcome.sh <slug> <phase> <complete|waiting-external|blocked|needs-human|partial|no-defect>' >&2
  echo '                        [--reason TEXT] [--watch REF]... [--wait-minutes N | --until ISO8601]' >&2
  echo '                        [--needs KEY] [--rule TEXT] [--command TEXT]' >&2
  echo '   --wait-minutes/--until: waiting-external | blocked | needs-human' >&2
  echo '   --needs KEY: REQUIRED on blocked | needs-human — a decision key from scripts/decisions.env' >&2
  echo "               ($DECISION_KEYS) or a blocker class as its short form ($NEED_CLASSES)" >&2
  echo '   --watch schemes: gh:<repo>#run/<id> · gh:<repo>#pr/<n> · date:<ISO> · lock:<slug>/<phase> · cmd:"<command>"' >&2
  echo '       phase-outcome.sh <slug> <phase> ruling --what TEXT [--why TEXT]' >&2
  echo '                        [--kind ambiguity|deviation|deferral] [--cost-if-wrong TEXT]' >&2
  echo '                        [--for <N|next|all>] [--needs KEY] [--remember plan|global]' >&2
  echo '   --for: who a DEFERRAL is left for (default next) — what `phase-graph.sh --notes N` collects' >&2
  echo '   --needs KEY on a ruling: the decision key it answers (stamped as decisionKey)' >&2
  echo '   --remember plan: write the ruling as a ## Decisions row (source ruling) and ack it' >&2
  echo '   --remember global: ask the owning console to set its policy.<key> answer to --what' >&2
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

# Why the console would never poll a --watch ref, or nothing when it would — the
# shapes `viewer/server/watch-refs.ts` `parseWatchRef` accepts, checked by shape
# (the console reads the calendar too). The-clock-is-evidence holds the two to
# one answer over a shared list of refs.
_watch_problem() {  # _watch_problem <ref>
  local body
  case "$1" in
    gh:*)
      printf '%s' "$1" | grep -Eq '^gh:[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*#(run|pr)/[0-9]+$' \
        || printf '%s' 'a gh: ref is gh:<owner/repo>#run/<id> or gh:<owner/repo>#pr/<n>'
      ;;
    date:*|until:*)
      printf '%s' "${1#*:}" | sed 's/^[[:space:]]*//' | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}' \
        || printf '%s' 'not an ISO8601 instant (date:2026-09-20T06:00:00Z)'
      ;;
    lock:*)
      printf '%s' "${1#lock:}" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]*/0*[1-9][0-9]*$' \
        || printf '%s' 'a lock: ref is lock:<slug>/<phase>'
      ;;
    cmd:*)
      body="$(printf '%s' "${1#cmd:}" | sed "s/^[[:space:]]*//; s/[[:space:]]*\$//; s/^\"\\(.*\\)\"\$/\\1/; s/^'\\(.*\\)'\$/\\1/" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
      [ -n "$body" ] || printf '%s' 'a cmd: ref names no command'
      ;;
    *)
      printf '%s' 'no watch scheme — the console polls gh:<owner/repo>#run/<id> · gh:<owner/repo>#pr/<n> · date:<ISO8601> · lock:<slug>/<phase> · cmd:"<command>"'
      ;;
  esac
}

reason=""; wait_minutes=""; until_iso=""
needs=""; rule=""; command_text=""
watch_count=0; watch_json=""
what=""; why=""; kind=""; cost=""; remember=""; by_word=""; for_whom=""
while [ $# -gt 0 ]; do
  case "$1" in
    --reason)       reason="${2:?--reason needs text}"; shift 2 ;;
    --needs)        needs="${2:?--needs needs a decision key}"; shift 2 ;;
    --rule)         rule="${2:?--rule needs text}"; shift 2 ;;
    --command)      command_text="${2:?--command needs text}"; shift 2 ;;
    --what)         what="${2:?--what needs text}"; shift 2 ;;
    --why)          why="${2:?--why needs text}"; shift 2 ;;
    --kind)         kind="${2:?--kind needs a word}"; shift 2 ;;
    --cost-if-wrong) cost="${2:?--cost-if-wrong needs text}"; shift 2 ;;
    --for)          for_whom="${2:?--for needs a phase number, next or all}"; shift 2 ;;
    --remember)     remember="${2:?--remember needs plan or global}"; shift 2 ;;
    --by)           by_word="${2:?--by needs a name}"; shift 2 ;;
    --wait-minutes) wait_minutes="${2:?--wait-minutes needs a number}"; shift 2 ;;
    --until)        until_iso="${2:?--until needs an ISO8601 time}"; shift 2 ;;
    --watch)
      ref="${2:?--watch needs a ref}"
      if [ "$watch_count" -lt 8 ]; then
        ref="$(printf '%s' "$ref" | cut -c1-200)"
        # Recorded either way — the reason still helps a person — but a ref no
        # scheme can parse is a ref nothing will ever probe, and saying so now,
        # while the session can still fix it, beats a park that silently runs on
        # a clock instead (WAI-11). The console names it on the park as well.
        problem="$(_watch_problem "$ref")"
        [ -n "$problem" ] && echo "warning: --watch \"$ref\" will never be checked: $problem" >&2
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
  if [ -n "$reason" ] || [ -n "$wait_minutes" ] || [ -n "$until_iso" ] || [ "$watch_count" -gt 0 ] \
     || [ -n "$rule" ] || [ -n "$command_text" ]; then
    echo '--reason/--watch/--wait-minutes/--until/--rule/--command belong to an outcome status, not to a ruling' >&2; exit 2
  fi
  [ -n "$what" ] || { echo '--what is required for a ruling (say what you decided)' >&2; exit 2; }
  # Absent means the weakest of the three: a session that simply chose between
  # two readings has not deviated from anything, and recording it as a
  # deviation would put a disagreement in the ledger that never happened.
  [ -n "$kind" ] || kind=ambiguity
  case "$kind" in ambiguity|deviation|deferral) : ;; *)
    echo "invalid --kind: $kind (want ambiguity|deviation|deferral)" >&2; exit 2 ;; esac
  # Who the deferral is FOR. Only a deferral has an addressee: an ambiguity and
  # a deviation are a session explaining itself, and `--for` on one would be a
  # note `--notes` will never collect and nobody will ever be told about.
  #
  # The default is `next` and it is WRITTEN rather than left to the reader:
  # "left for later" without a name means "for whoever comes next", and a
  # reader that had to know the default is a second place the default lives.
  if [ -n "$for_whom" ]; then
    [ "$kind" = deferral ] || { echo "--for belongs to --kind deferral: an $kind is a session explaining itself, not a note addressed to a phase" >&2; exit 2; }
    case "$for_whom" in
      next|all) : ;;
      ''|*[!0-9]*) echo "invalid --for: $for_whom (want a phase number, next or all)" >&2; exit 2 ;;
      0*) [ "$((10#$for_whom))" -gt 0 ] || { echo "invalid --for: $for_whom (a phase is numbered from 1)" >&2; exit 2; } ;;
      *) [ "$for_whom" -gt 0 ] || { echo "invalid --for: $for_whom (a phase is numbered from 1)" >&2; exit 2; } ;;
    esac
  elif [ "$kind" = deferral ]; then
    for_whom=next
  fi
  # The key a ruling answers is a manifest KEY, never a blocker short form: a
  # ruling decided something, it is not declaring what blocks it.
  if [ -n "$needs" ]; then
    case " $DECISION_KEYS " in
      *" $needs "*) : ;;
      *) echo "unknown --needs key on a ruling: $needs (want one of: $DECISION_KEYS)" >&2; exit 2 ;;
    esac
  fi
  case "$remember" in
    '') : ;;
    plan|global)
      [ -n "$needs" ] || { echo "--remember $remember needs --needs <key>: a ruling is remembered under the decision key it answers" >&2; exit 2; } ;;
    *) echo "invalid --remember: $remember (want plan|global)" >&2; exit 2 ;;
  esac
elif [ -n "$what" ] || [ -n "$why" ] || [ -n "$kind" ] || [ -n "$cost" ] || [ -n "$remember" ] || [ -n "$by_word" ] || [ -n "$for_whom" ]; then
  echo "--what/--why/--kind/--cost-if-wrong/--for/--remember/--by only make sense with ruling, not $status" >&2; exit 2
fi

if [ -n "$wait_minutes" ] && [ -n "$until_iso" ]; then
  echo '--wait-minutes and --until are mutually exclusive' >&2; exit 2
fi
# The decision key is the machine field on the two statuses that ASK (chapter
# 10 ZTD-3): without it the classifier is a regex over prose, and `unknown` was
# 39 % of every ask. Required there, refused elsewhere — a key on `complete` is
# a session describing a block it is not declaring.
case "$status" in
  blocked|needs-human)
    if [ -z "$needs" ]; then
      echo "--needs <key> is required on $status: name the decision you are missing — one of: $DECISION_KEYS — or its short form: $NEED_CLASSES" >&2
      exit 2
    fi
    case " $DECISION_KEYS $NEED_CLASSES " in
      *" $needs "*) : ;;
      *) echo "unknown --needs word: $needs (want one of: $DECISION_KEYS — or: $NEED_CLASSES)" >&2; exit 2 ;;
    esac
    ;;
  *)
    if [ "$mode" = outcome ] && { [ -n "$needs" ] || [ -n "$rule" ] || [ -n "$command_text" ]; }; then
      echo "--needs/--rule/--command only make sense with blocked or needs-human, not $status" >&2; exit 2
    fi
    ;;
esac
rule="$(printf '%s' "$rule" | cut -c1-200)"
command_text="$(printf '%s' "$command_text" | cut -c1-500)"
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
  # The id the console derives on read (rulings.ts rulingId), stamped here so
  # the ack line, the inbox row and decisions.sh promote can name this ruling
  # without re-deriving it — and an old ledger line without one still reads.
  ruling_id="$(pe_sha256_hex "$slug $phase $now $what" | cut -c1-12)"
  why_json="$( [ -n "$why" ] && printf ',"why":"%s"' "$(_json_str "$why")" || true )"
  cost_json="$( [ -n "$cost" ] && printf ',"cost_if_wrong":"%s"' "$(_json_str "$cost")" || true )"
  key_json="$( [ -n "$needs" ] && printf ',"decisionKey":"%s"' "$needs" || true )"
  for_json="$( [ -n "$for_whom" ] && printf ',"for":"%s"' "$for_whom" || true )"
  session_json="$( [ -n "$session" ] && printf ',"session_id":"%s"' "$session" || true )"
  id_json="$( [ -n "$ruling_id" ] && printf '"id":"%s",' "$ruling_id" || true )"
  # ONE line: the file is NDJSON and a pretty-printed record would make every
  # reader a parser with state.
  line="{\"version\":1,\"type\":\"ruling\",${id_json}\"slug\":\"$(_json_str "$slug")\",\"phase\":$phase,\"kind\":\"$kind\",\"what\":\"$(_json_str "$what")\"${why_json}${cost_json}${for_json}${key_json}${session_json},\"at\":\"$(_json_str "$now")\"}"

  written=0
  if [ -n "${PE_RULINGS_FILE:-}" ]; then
    ledger="$PE_RULINGS_FILE"
    if mkdir -p "$(dirname "$ledger")" 2>/dev/null && printf '%s\n' "$line" >> "$ledger" 2>/dev/null; then
      echo "ruling recorded: $slug phase $phase ($kind)  ->  $ledger"
      written=1
    else
      echo "note: $ledger could not be written — printing the ruling only" >&2
      printf '%s\n' "$line"
    fi
  else
    root="$(pe_instance_root)"
    ledger="$(pe_runs_dir "$root" "$slug")/rulings.ndjson"
    if mkdir -p "$(dirname "$ledger")" 2>/dev/null && printf '%s\n' "$line" >> "$ledger" 2>/dev/null; then
      echo "note: PE_RULINGS_FILE is not set (no runner is supervising this session) — recorded for the console at $ledger" >&2
      written=1
    else
      echo "note: PE_RULINGS_FILE is not set and $ledger could not be written — printing the ruling only" >&2
    fi
    printf '%s\n' "$line"
  fi
  [ -n "$remember" ] || exit 0

  # ---- --remember: the ruling becomes a standing answer -----------------------
  # Only a recorded ruling can be remembered: the row's evidence and the
  # console's action both name the id, and an id that is in no ledger is a
  # promise nobody can check.
  if [ "$written" != 1 ] || [ -z "$ruling_id" ]; then
    echo "not remembered: the ruling could not be written to a ledger (or no sha256 tool is installed), so there is nothing to promote" >&2
    exit 1
  fi
  # Who remembers it. The autopilot's exported owner, else user@host —
  # decisions.sh's own default, spelled here so the ack line says the same.
  [ -n "$by_word" ] || by_word="${PE_OWNER:-$(whoami 2>/dev/null || echo operator)@$(hostname -s 2>/dev/null || hostname)}"
  by_word="$(printf '%s' "$by_word" | tr '\r\n\t' '   ' | cut -c1-64)"
  if [ "$remember" = plan ]; then
    # decisions.sh reads the same ledger: exported so an injected
    # PE_RULINGS_FILE (a lane, a test) is honoured rather than re-derived.
    if PE_RULINGS_FILE="$ledger" "$SCRIPT_DIR/decisions.sh" "$slug" promote --from-ruling "$ruling_id" --key "$needs" --by "$by_word"; then
      ack="{\"version\":1,\"type\":\"ack\",\"id\":\"$ruling_id\",\"at\":\"$(_json_str "$now")\",\"by\":\"$(_json_str "$by_word")\"}"
      printf '%s\n' "$ack" >> "$ledger" 2>/dev/null || echo "note: the ruling was promoted but its ack could not be appended to $ledger" >&2
      echo "remembered for plan $slug: $needs  ->  docs/handoffs/$slug/decisions.md (source ruling, evidence ruling $ruling_id)"
      exit 0
    fi
    echo "the ruling is recorded ($ruling_id) but was not promoted — see decisions.sh above; promote it by hand: decisions.sh $slug promote --from-ruling $ruling_id --key $needs" >&2
    exit 1
  fi
  # global: the console that owns this repository holds the policy override,
  # and it is the only writer of its own preferences — so it is asked, over
  # the same door the inbox's "Remember on this console" action uses.
  url="$(pe_console_url "$(pe_docs_root)")"
  fallback="set \`$needs\` under Settings ▸ Automation ▸ Policy answers, or run --remember plan"
  if [ -z "$url" ]; then
    echo "not remembered globally: no console is registered for this repository (and PHASE_CONSOLE_URL is unset) — $fallback" >&2
    exit 1
  fi
  command -v curl >/dev/null 2>&1 || { echo "not remembered globally: curl is not installed — $fallback" >&2; exit 1; }
  body="{\"scope\":\"global\",\"by\":\"$(_json_str "$by_word")\"}"
  reply_file="$(mktemp "${TMPDIR:-/tmp}/pe-remember.XXXXXX")"
  code="$(curl -sS -o "$reply_file" -w '%{http_code}' --connect-timeout 2 --max-time 10 \
      -X POST "$url/api/run/$slug/rulings/$ruling_id/remember" \
      -H 'content-type: application/json' -H 'x-phase-console: 1' --data "$body" 2>/dev/null || true)"
  # curl prints 000 AND exits non-zero on a refused connection; anything that
  # is not three digits reads as "nobody answered".
  case "$code" in [0-9][0-9][0-9]) : ;; *) code=000 ;; esac
  reply="$(cat "$reply_file" 2>/dev/null | cut -c1-600)"; rm -f "$reply_file"
  case "$code" in
    200) echo "remembered on this console ($url): policy.$needs  ->  $reply"; exit 0 ;;
    000) echo "not remembered globally: no console answers at $url — $fallback" >&2; exit 1 ;;
    *)   echo "not remembered globally: the console at $url answered $code: $reply — $fallback" >&2; exit 1 ;;
  esac
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
needs_line="$( [ -n "$needs" ] && printf '\n  "needs": "%s",' "$(_json_str "$needs")" || true )"
rule_line="$( [ -n "$rule" ] && printf '\n  "rule": "%s",' "$(_json_str "$rule")" || true )"
command_line="$( [ -n "$command_text" ] && printf '\n  "command": "%s",' "$(_json_str "$command_text")" || true )"
resume_line="$( [ -n "$resume_after" ] && printf '\n  "resume_after": "%s",' "$(_json_str "$resume_after")" || true )"
session_line="$( [ -n "$session" ] && printf '\n  "session_id": "%s",' "$session" || true )"
# The trace this session belongs to (5.1.0). A declaration is the one thing the
# runner acts on, so "which drive was this the outcome of" is exactly the
# question worth being able to answer from the file alone — and after a console
# restart the file is often all that is left. `span` rides WITH `trace`, never
# without: a span id alone points into a trace nobody named.
trace_line="$( [ -n "${PE_TRACE_ID:-}" ] && printf '\n  "trace": "%s",' "$(_json_str "$PE_TRACE_ID")" || true )"
span_line="$( [ -n "${PE_TRACE_ID:-}" ] && [ -n "${PE_SPAN_ID:-}" ] \
  && printf '\n  "span": "%s",' "$(_json_str "$PE_SPAN_ID")" || true )"

json="{
  \"version\": 1,
  \"slug\": \"$(_json_str "$slug")\",
  \"phase\": $phase,
  \"status\": \"$status\",${reason_line}${needs_line}${rule_line}${command_line}${resume_line}${session_line}${trace_line}${span_line}
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
  # `phase-NN-<written_at>.json`, never the bare `phase-NN.json` it used to be:
  # one name per phase meant a second declaration `mv`'d over an unread first,
  # and this inbox is the ONLY channel a session nobody supervises has into the
  # autopilot — a channel that destroys its own backlog is prose with extra
  # steps. The basic ISO form (no colons, no dashes) is legal on every
  # filesystem AND sorts oldest-first as a plain string, which is exactly what
  # lets the console ingest a backlog in the order it was written.
  target="$inbox/phase-$(printf '%02d' "$phase")-$(printf '%s' "$now" | tr -d ':-').json"
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
