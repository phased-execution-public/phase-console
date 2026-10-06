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
#        phase-outcome.sh <slug> <phase> verified --command TEXT --exit N [--in DIR]
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
#   --step KIND  needs-human ONLY (control-tower phase 41): the ask is a HUMAN
#             STEP — a typed act only a person can do — rather than a free-text
#             errand. KIND is one of scripts/human-steps.env HUMAN_STEP_KINDS;
#             its fields ride the JSON as `step`:
#               --title TEXT             what the person must do (required)
#               --open-url URL | --open-command CMD   what to open: an http(s)
#                                        link, or a command for the terminal
#               --where host|any         where it can be done (default: the kind's)
#               --proof REF              the watch ref that proves it was done
#               --step-line TEXT         a numbered step, repeatable (max 12)
#               --code CODE              device-code only: the short code to show
#               --credential ID          secret-entry only (required): the
#                                        registry id the secret is stored under
#               --due-when REF           (control-tower phase 121) a watch ref:
#                                        the step is `upcoming` — shown, never
#                                        pushed or reminded — until it lands,
#                                        then due, with ONE push
#   --act     sugar for `--step operator-act` (control-tower phase 121, #182):
#             an act only the operator does — a command (--open-command) or a
#             click path (--open-url and --step-line) — usually with --due-when.
#             The push says "NOW: <command>" the moment it is due.
#             A value shaped like a secret — a token, a password, a one-time
#             code, a URL query secret — is REFUSED (exit 2, nothing written):
#             codes and secrets never enter a declaration. A step a session
#             declares never opens by itself; only a plan's may (`auto-open`).
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
# `verified` is the third shape, and like a ruling it is never an outcome: it
# records what the session's OWN §Verification proved — the command, its exit
# status and the tree it ran against (control-tower phase 62, #68) — so the
# console's pass after the session re-runs only what was NOT proven at an
# equivalent tree: the same tree, or one where only paperwork changed since
# (docs/handoffs/**, .locks/**, CHANGELOG.md). The tree is the WORKING tree's
# content, committed or not — the git index copied, every change added, written
# as a tree object — because a session tests and then commits, and a proof
# pinned to HEAD would go stale the moment the commit it proved landed. The
# session's own index is never touched. The tree is keyed where the console
# JUDGES the phase's lines (control-tower phase 106, #196): by default the
# directory the runner names in $PE_VERIFY_DIR (unsupervised: the run root moved
# by the plan's `Verify in:`), whatever directory the session's shell stands
# in; --in names another, and a relative --in is resolved against the RUN ROOT
# ($PE_RUN_ROOT, else $PE_WORKTREE, else the outermost superproject of this
# checkout) — never against $PWD. A proof whose tree is not an object of the
# repository the console judges in is refused NOW (exit 2), naming both trees,
# rather than refused at the verdict and the line re-run; outside a git working
# tree there is nothing to prove against (exit 2). ONE NDJSON line to $PE_PROOFS_FILE (the runner
# injects it) or, unsupervised, to <state>/phase-console/runs/<instance id>/<slug>/proofs.ndjson
# — the same per-plan file the console reads. Record each command as you run it,
# red ones too: a red proof is not a proof, and the console runs that one itself.
#
# `progress` is the fourth shape, and like the other two it is never an outcome:
# how far the ACTIVE task's long operation has got — `--label <what> --done <n>
# --of <m>` ("iOS sweep vendor", 45 of 68) — control-tower phase 95, #163. It is
# ONE NDJSON line on the task channel, $PE_TASKS_FILE, which the runner tails
# while the session works, so it is journalled as `phase.progress` on the task
# in progress at the next tool result rather than at exit; unsupervised it goes
# to the console's inbox task file for the phase. --done and --of are whole
# numbers, 1 <= --of, --done <= --of; a malformed call writes nothing (exit 2).
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
# A declaration that parks (waiting-external, blocked, needs-human) and names
# --watch refs is first STAGED and the console asked whether a ref has already
# landed (POST /hooks/declaration, ≤ 20 s — control-tower phase 50, #86). If one
# has, nothing is written, nothing parks, and the exit is 3: carry on with the
# phase. No console answering, or none landed: written as above, exit 0.
# Exit: 0 written/printed · 1 a ruling not remembered · 2 usage, or a --watch ref refused
# (too long, not self-contained, or refused by the console at declaration) · 3 already landed — continue
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/instance.sh"
# The decision manifest's vocabulary — the OWNER is viewer/shared/decisions-model.js,
# decisions.env its bash twin (held equal by viewer/test/decisions-model.test.ts).
DECISION_KEYS="permission.policy permission.destructive issues credentials accounts mcp gates verification.person-check qa.exhausted waits human-acts ambiguity budgets resume.on-restart plan-health stop relay announce plan-approval"
NEED_CLASSES="lock permission credential gate external"
# Why a --watch naming the declaring phase's OWN lock is refused (#42): the
# console claims that lock for the session and releases it at its closeout, so
# the watch fired on the phase's own teardown and resumed a session for work
# that never existed. Word for word the console's `OWN_LOCK_WATCH_REFUSAL`
# (viewer/shared/run-lifecycle.js), which refuses the same ref at ingest for a
# file an older script wrote; own-lock-watch.test.ts holds the two together.
OWN_LOCK_WATCH_REFUSAL="a lock: watch is for somebody else's lock: this one names the declaring phase's own lock, which its own closeout releases, so the watch would fire on its own teardown (#42). Name the lock phase-lock.sh conflicts reported instead, or declare --needs lock with no watch and the console queues the phase behind whoever holds it; a phase blocked on a person takes no watch at all."
# shellcheck source=/dev/null
[ -f "$SCRIPT_DIR/decisions.env" ] && . "$SCRIPT_DIR/decisions.env"
# A person's turn (control-tower phase 41) — the OWNER is
# viewer/shared/human-step-model.js, twin scripts/human-steps.env.
HUMAN_STEP_KINDS="browser-login device-code one-time-code secret-entry claude-login mcp-login os-prompt os-permission third-party-approval physical person-check decision protected-path interactive-prompt captcha email-link"
HUMAN_STEP_WHERE="host any"
HUMAN_STEP_DEFAULT_WHERE="browser-login:host device-code:any one-time-code:host secret-entry:any claude-login:host mcp-login:host os-prompt:host os-permission:host third-party-approval:any physical:host person-check:any decision:any protected-path:host interactive-prompt:host captcha:any email-link:any"
HUMAN_STEP_SECRET_PATTERNS=''
HUMAN_STEP_SECRET_QUERY_KEYS=''
# shellcheck source=/dev/null
[ -f "$SCRIPT_DIR/human-steps.env" ] && . "$SCRIPT_DIR/human-steps.env"

usage() {
  echo 'usage: phase-outcome.sh <slug> <phase> <complete|waiting-external|blocked|needs-human|partial|no-defect>' >&2
  echo '                        [--reason TEXT] [--watch REF]... [--wait-minutes N | --until ISO8601]' >&2
  echo '                        [--needs KEY] [--rule TEXT] [--command TEXT]' >&2
  echo '   --wait-minutes/--until: waiting-external | blocked | needs-human' >&2
  echo '   --needs KEY: REQUIRED on blocked | needs-human — a decision key from scripts/decisions.env' >&2
  echo '   --step KIND --title TEXT [--open-url URL | --open-command CMD] [--where host|any] [--proof REF]' >&2
  echo '        [--step-line TEXT]... [--code CODE] [--credential ID] [--due-when REF]: needs-human only — a human step' >&2
  echo '   --act: --step operator-act — the operator'"'"'s own act (a command or a click path), due when --due-when lands' >&2
  echo "               ($DECISION_KEYS) or a blocker class as its short form ($NEED_CLASSES)" >&2
  echo '   --watch schemes: gh:<repo>#run/<id> · gh:<repo>#pr/<n> · date:<ISO> · lock:<slug>/<phase> · phase:<slug>/<phase> · verify:<slug>/<phase> · cmd:"<command>" · unit:<host>/<unit>' >&2
  echo '       unit:<host>/<unit> lands when that systemd unit on that host leaves activating/active (the host is named in the machine profile);' >&2
  echo '       a date: beside a live ref is a BACKSTOP: the ref wakes the phase, the date only bounds the wait' >&2
  echo '       phase:<slug>/<N> lands when the console reads sibling phase N done — the way to wait on a sibling;' >&2
  echo '       verify:<slug>/<this phase> lands when your own red §Verification lines pass again on a new head;' >&2
  echo '       a cmd: ref is self-contained (absolute paths, no $, no cd, at most 1000 characters) and exits 0 only once the thing has happened' >&2
  echo '       phase-outcome.sh <slug> <phase> ruling --what TEXT [--why TEXT]' >&2
  echo '                        [--kind ambiguity|deviation|deferral] [--cost-if-wrong TEXT]' >&2
  echo '                        [--for <N|next|all>] [--needs KEY] [--remember plan|global]' >&2
  echo '   --for: who a DEFERRAL is left for (default next) — what `phase-graph.sh --notes N` collects' >&2
  echo '   --needs KEY on a ruling: the decision key it answers (stamped as decisionKey)' >&2
  echo '   --remember plan: write the ruling as a ## Decisions row (source ruling) and ack it' >&2
  echo '   --remember global: ask the owning console to set its policy.<key> answer to --what' >&2
  echo '       phase-outcome.sh <slug> <phase> verified --command TEXT --exit N [--in DIR]' >&2
  echo '   verified: record what your own §Verification proved — the console re-runs only what you did not prove' >&2
  echo '       phase-outcome.sh <slug> <phase> progress --label TEXT --done N --of M' >&2
  echo '   progress: how far the active task'"'"'s long operation has got (journalled as phase.progress)' >&2
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
  verified) mode=proof ;;
  progress) mode=progress ;;
  *) echo "invalid status: $status (want complete|waiting-external|blocked|needs-human|partial|no-defect, or ruling, verified or progress)" >&2; exit 2 ;;
esac

# JSON string sanitizer, bash 3.2 + BSD sed: control chars (newlines included)
# become spaces, then backslash and quote are escaped. Defined before the arg
# loop because --watch builds its JSON inline (bash 3.2 has no arrays worth
# passing around, so the refs are folded as they arrive).
_json_str() {
  printf '%s' "$1" | tr '\000-\037' ' ' | sed 's/\\/\\\\/g; s/"/\\"/g'
}

# The redaction floor at the door (control-tower phase 41): is this value
# shaped like a secret? The shapes are human-steps.env's, matched as
# case-insensitive EREs — the same list `looksLikeSecret` in
# viewer/shared/human-step-model.js reads — plus a URL query parameter whose
# name says its value is one (an OAuth `code`, an `access_token`, a signature).
_looks_like_secret() {  # _looks_like_secret <text> → 0 when it carries a secret
  local text="$1" pat q pair name value found=1
  [ -z "$text" ] && return 1
  set -f
  shopt -s nocasematch
  for pat in $HUMAN_STEP_SECRET_PATTERNS; do
    if [[ $text =~ $pat ]]; then found=0; break; fi
  done
  shopt -u nocasematch
  if [ "$found" -ne 0 ]; then
    case "$text" in
      *'?'*|*'#'*)
        q="${text#*[?#]}"
        q="$(printf '%s' "$q" | tr '#' '&')"
        local IFS='&'
        for pair in $q; do
          name="${pair%%=*}"
          [ "$name" = "$pair" ] && continue
          value="${pair#*=}"
          [ -z "$value" ] && continue
          name="$(printf '%s' "$name" | tr 'A-Z' 'a-z')"
          case " $HUMAN_STEP_SECRET_QUERY_KEYS " in *" $name "*) found=0; break ;; esac
        done
        ;;
    esac
  fi
  set +f
  return "$found"
}

# Refuse a flag whose value carries a secret — exit 2, nothing written, and the
# value is never echoed back (the terminal is a sink too).
_screen_secret() {  # _screen_secret <flag> <value>
  if _looks_like_secret "$2"; then
    echo "$1 refused: its value is shaped like a secret (a token, a password, a one-time code or a URL query secret). A human step never carries one — say what to do and where; the person types the secret where the step opens, never into a declaration." >&2
    exit 2
  fi
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
    lock:*|phase:*|verify:*)
      printf '%s' "${1#*:}" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]*/0*[1-9][0-9]*$' \
        || printf '%s' "a ${1%%:*}: ref is ${1%%:*}:<slug>/<phase>"
      ;;
    cmd:*)
      [ -n "$(_cmd_body "$1")" ] || printf '%s' 'a cmd: ref names no command'
      ;;
    unit:*)
      # A host the machine profile names and a systemd unit (control-tower
      # phase 121, #181). The console runs `systemctl show` over ssh, and ssh
      # hands its command to the REMOTE shell — so the shape is the whole
      # safety: no leading dash (an ssh option), no shell character at all.
      # `watch-refs.ts` `UNIT_REF_RE` is the twin.
      printf '%s' "$1" | grep -Eq '^unit:[A-Za-z0-9][A-Za-z0-9._-]{0,62}/[A-Za-z0-9][A-Za-z0-9@._:-]{0,254}$' \
        || printf '%s' 'a unit: ref is unit:<host>/<unit> — a host the machine profile names, a systemd unit name (letters, digits, @ . _ : -), nothing else'
      ;;
    *)
      printf '%s' 'no watch scheme — the console polls gh:<owner/repo>#run/<id> · gh:<owner/repo>#pr/<n> · date:<ISO8601> · lock:<slug>/<phase> · phase:<slug>/<phase> · verify:<slug>/<phase> · cmd:"<command>" · unit:<host>/<unit>'
      ;;
  esac
}

# The command a cmd: ref runs — the ref's own quote pair is punctuation, exactly
# as `watch-refs.ts` `parseWatchRef` strips it.
_cmd_body() {  # _cmd_body <ref>
  printf '%s' "${1#cmd:}" | sed "s/^[[:space:]]*//; s/[[:space:]]*\$//; s/^\"\\(.*\\)\"\$/\\1/; s/^'\\(.*\\)'\$/\\1/" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//'
}

# Does every quote in <text> close? Backslash escapes outside single quotes, as
# the shell the console runs it in reads them (control-tower phase 88, #125).
_quotes_balanced() {  # _quotes_balanced <text>
  local s="$1" i=0 n="${#1}" c q=""
  while [ "$i" -lt "$n" ]; do
    c="${s:$i:1}"
    if [ -z "$q" ]; then
      case "$c" in \\) i=$((i + 1)) ;; "'") q="'" ;; '"') q='"' ;; esac
    elif [ "$q" = "'" ]; then
      [ "$c" = "'" ] && q=""
    else
      case "$c" in \\) i=$((i + 1)) ;; '"') q="" ;; esac
    fi
    i=$((i + 1))
  done
  [ -z "$q" ]
}

# The first word of <command> that is a path relative to the session's working
# directory, or nothing. The console runs a cmd: ref from ITS root, so such a
# path names another file, or none (#152). Read as words with the quotes
# dropped; a flag, a URL, an assignment, `owner/repo` after -R/--repo and a sed
# expression are not paths. The JS twin is `watch-refs.ts` `relativePathIn`.
_relative_path_in() {  # _relative_path_in <command>
  local words word prev="" found=""
  words="$(printf '%s' "$1" | tr "\"'" '  ')"
  set -f
  for word in $words; do
    case "$prev" in -R|--repo) prev="$word"; continue ;; esac
    prev="$word"
    case "$word" in
      ./*|../*) found="$word"; break ;;
      /*|\~*|-*|*://*|*=*|s/*|y/*) continue ;;
      */*) ;;
      *) continue ;;
    esac
    case "$word" in *[!A-Za-z0-9._/@+-]*) continue ;; esac
    if printf '%s' "$word" | grep -Eq '/.*/|\.[A-Za-z0-9]{1,8}$'; then found="$word"; break; fi
  done
  set +f
  [ -n "$found" ] && printf '%s' "$found"
  return 0
}

# Why the console could not run a cmd: ref AS WRITTEN — the shapes that exit 2
# here rather than park on a ref nothing can land (control-tower phase 88, #125,
# #152). A cmd: ref is self-contained: absolute paths, no shell variable, no
# substitution, every quote closed. The console's own policy is asked too, at
# declaration (`_probe_declaration`), and its refusal also exits 2.
_cmd_ref_problem() {  # _cmd_ref_problem <ref>
  local body rel
  body="$(_cmd_body "$1")"
  case "$body" in
    *'$'*) printf '%s' 'it carries a shell variable or substitution ($) — the console runs a cmd: ref in a shell of its own, where your session'"'"'s variables do not exist; write the value out'; return 0 ;;
    *'`'*) printf '%s' 'it carries a command substitution (a backtick) whose inner command the console cannot judge'; return 0 ;;
  esac
  if ! _quotes_balanced "$body"; then
    printf '%s' 'its quoting does not balance (a quote never closes) — the console would refuse it as unreadable; close every quote'
    return 0
  fi
  rel="$(_relative_path_in "$body")"
  [ -n "$rel" ] && printf '%s' "it names a relative path ($rel) — the console runs a cmd: ref from its own root, not your working directory; write the absolute path"
  return 0
}

# Advice for a well-formed ref the console has a better scheme for — printed,
# never refused: a handoff's status is console state (`phase:`), and a workflow
# run is a `gh:` ref (#129, #87's optional ask).
_cmd_ref_hints() {  # _cmd_ref_hints <ref>
  local body hit repo sha wf lookup
  body="$(_cmd_body "$1")"
  hit="$(printf '%s' "$body" | sed -nE 's#.*docs/handoffs/([A-Za-z0-9][A-Za-z0-9._-]*)/phase-0*([1-9][0-9]*)-.*#\1/\2#p' | head -1)"
  case "$body" in *grep*) [ -n "$hit" ] && echo "warning: --watch \"$1\" greps a handoff the console reads itself — --watch phase:$hit lands when the console's record of that phase reads done (after its own §Verification), and a board change re-probes it at once" >&2 ;; esac
  case "$body" in
    *'gh run list'*'--commit'*)
      repo="$(printf '%s' "$body" | sed -nE 's/.*(-R|--repo)[ =]([^ ]+).*/\2/p' | head -1)"
      sha="$(printf '%s' "$body" | sed -nE 's/.*--commit[ =]([^ ]+).*/\1/p' | head -1)"
      wf="$(printf '%s' "$body" | sed -nE 's/.*(--workflow|-w)[ =]([^ ]+).*/\2/p' | head -1)"
      lookup="gh run list${repo:+ -R $repo}${wf:+ --workflow $wf} --commit $sha --json databaseId -q '.[0].databaseId'"
      echo "note: --watch \"$1\" asks gh through a command; a gh: ref watches the run itself and lands when it completes — gh:${repo:-<owner/repo>}#run/<id>, the id from: $lookup" >&2
      ;;
  esac
  return 0
}

# Does <ref> name THIS phase's own lock — lock:<slug>/<phase>, leading zeros
# and surrounding blanks allowed, exactly the grammar `_watch_problem` accepts?
_own_lock_ref() {  # _own_lock_ref <ref>
  case "$1" in lock:*) _names_own_phase "$1" ;; *) return 1 ;; esac
}

# Does a well-formed <scheme>:<slug>/<phase> ref name THIS phase?
_names_own_phase() {  # _names_own_phase <ref>
  local body
  body="$(printf '%s' "${1#*:}" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
  printf '%s' "$body" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]*/0*[1-9][0-9]*$' || return 1
  [ "${body%/*}" = "$slug" ] && [ "$((10#${body##*/}))" -eq "$phase" ]
}

# The longest --watch ref this script records (control-tower phase 88, #125). A
# realistic two-check AWS or gh proof is 250–400 characters; the old silent cut
# at 200 split one mid-word. A longer ref is refused, never cut.
WATCH_REF_MAX=1000

reason=""; wait_minutes=""; until_iso=""
needs=""; rule=""; command_text=""
watch_count=0; watch_json=""
what=""; why=""; kind=""; cost=""; remember=""; by_word=""; for_whom=""
exit_code=""; in_dir=""
label=""; done_n=""; of_n=""; progress_flags=""
step_kind=""; step_title=""; step_open_url=""; step_open_command=""; step_where=""; step_proof=""
step_lines_json=""; step_line_count=0; step_code=""; step_credential=""; step_flags=""
step_act=""; step_due_when=""; watch_refs=""
while [ $# -gt 0 ]; do
  case "$1" in
    --label|--done|--of)
      # Validated here rather than by ${2:?}: an empty or missing value is a
      # malformed call, and a malformed call is exit 2 with nothing written.
      [ $# -ge 2 ] || { echo "$1 needs a value" >&2; exit 2; }
      case "$1" in --label) label="$2" ;; --done) done_n="$2" ;; --of) of_n="$2" ;; esac
      progress_flags="${progress_flags}x"; shift 2 ;;
    --exit)         exit_code="${2:?--exit needs the exit status}"; shift 2 ;;
    --in)           in_dir="${2:?--in needs a directory}"; shift 2 ;;
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
    --step)         step_kind="${2:?--step needs a kind}"; shift 2 ;;
    --act)          step_act=1; step_flags=1; shift ;;
    --due-when)     step_due_when="${2:?--due-when needs a watch ref}"; step_flags=1; shift 2 ;;
    --title)        step_title="${2:?--title needs text}"; step_flags=1; shift 2 ;;
    --open-url)     step_open_url="${2:?--open-url needs a link}"; step_flags=1; shift 2 ;;
    --open-command) step_open_command="${2:?--open-command needs a command}"; step_flags=1; shift 2 ;;
    --where)        step_where="${2:?--where needs host or any}"; step_flags=1; shift 2 ;;
    --proof)        step_proof="${2:?--proof needs a ref}"; step_flags=1; shift 2 ;;
    --code)         step_code="${2:?--code needs the code}"; step_flags=1; shift 2 ;;
    --credential)   step_credential="${2:?--credential needs an id}"; step_flags=1; shift 2 ;;
    --step-line)
      line_text="${2:?--step-line needs text}"; step_flags=1
      _screen_secret --step-line "$line_text"
      if [ "$step_line_count" -lt 12 ]; then
        step_lines_json="${step_lines_json:+$step_lines_json,}\"$(_json_str "$(printf '%s' "$line_text" | cut -c1-300)")\""
        step_line_count=$((step_line_count + 1))
      else
        echo "ignoring --step-line beyond the 12th" >&2
      fi
      shift 2 ;;
    --watch)
      ref="${2:?--watch needs a ref}"
      if _own_lock_ref "$ref"; then
        echo "--watch $ref refused: $OWN_LOCK_WATCH_REFUSAL" >&2
        exit 2
      fi
      if [ "$watch_count" -lt 8 ]; then
        # Never cut (control-tower phase 88, #125): a ref shortened here was a
        # different ref — the #125 one lost its closing quote — and the console
        # refused it after the session had gone. Too long is exit 2, now.
        if [ "${#ref}" -gt "$WATCH_REF_MAX" ]; then
          echo "--watch refused: the ref is ${#ref} characters and the limit is $WATCH_REF_MAX characters — nothing was written; shorten it (a script at an absolute path is one short ref)" >&2
          exit 2
        fi
        case "$ref" in
          phase:*)
            if _names_own_phase "$ref"; then
              echo "--watch $ref refused: a phase cannot wait for its own completion — name the SIBLING phase this one waits on (phase:<slug>/<N>)" >&2
              exit 2
            fi ;;
          verify:*)
            if [ -z "$(_watch_problem "$ref")" ] && ! _names_own_phase "$ref"; then
              echo "--watch $ref refused: a verify: ref re-runs the DECLARING phase's own red §Verification lines — write verify:$slug/$phase" >&2
              exit 2
            fi ;;
          cmd:*)
            problem="$(_cmd_ref_problem "$ref")"
            if [ -n "$problem" ]; then
              echo "--watch $ref refused: $problem. Nothing was written." >&2
              exit 2
            fi
            _cmd_ref_hints "$ref" ;;
          unit:*)
            # Refused, not warned: a malformed unit: ref is a string the console
            # would hand to a remote shell (control-tower phase 121).
            problem="$(_watch_problem "$ref")"
            if [ -n "$problem" ]; then
              echo "--watch $ref refused: $problem. Nothing was written." >&2
              exit 2
            fi ;;
        esac
        # Recorded either way — the reason still helps a person — but a ref no
        # scheme can parse is a ref nothing will ever probe, and saying so now,
        # while the session can still fix it, beats a park that silently runs on
        # a clock instead (WAI-11). The console names it on the park as well.
        problem="$(_watch_problem "$ref")"
        [ -n "$problem" ] && echo "warning: --watch \"$ref\" will never be checked: $problem" >&2
        watch_json="${watch_json:+$watch_json, }\"$(_json_str "$ref")\""
        watch_refs="${watch_refs}${ref}
"
        watch_count=$((watch_count + 1))
      else
        echo "ignoring --watch beyond the 8th: $ref" >&2
      fi
      shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

# The shapes share one option loop and are then held apart, so a flag that
# belongs to another one is an error rather than a silent no-op.
if [ "$mode" = progress ]; then
  if [ -n "$reason" ] || [ -n "$wait_minutes" ] || [ -n "$until_iso" ] || [ "$watch_count" -gt 0 ] \
     || [ -n "$rule" ] || [ -n "$command_text" ] || [ -n "$needs" ] || [ -n "$what$why$kind$cost$for_whom$remember$by_word" ] \
     || [ -n "$exit_code$in_dir" ]; then
    echo 'progress takes --label, --done and --of only' >&2; exit 2
  fi
  [ -n "$label" ] || { echo '--label is required for progress: say what is being measured' >&2; exit 2; }
  case "$done_n" in ''|*[!0-9]*) echo "--done needs a whole number, got: ${done_n:-nothing}" >&2; exit 2 ;; esac
  case "$of_n" in ''|*[!0-9]*) echo "--of needs a whole number, got: ${of_n:-nothing}" >&2; exit 2 ;; esac
  done_n=$((10#$done_n)); of_n=$((10#$of_n))
  [ "$of_n" -ge 1 ] || { echo '--of must be at least 1' >&2; exit 2; }
  [ "$done_n" -le "$of_n" ] || { echo "--done ($done_n) is more than --of ($of_n)" >&2; exit 2; }
  label="$(printf '%s' "$label" | tr '\n\t' '  ' | cut -c1-200)"
elif [ -n "$progress_flags" ]; then
  echo "--label/--done/--of only make sense with progress, not $status" >&2; exit 2
fi
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

# The proof shape owns --exit and --in and needs --command; every outcome flag
# is refused on it (the ruling flags already were, just above).
if [ "$mode" = proof ]; then
  if [ -n "$reason" ] || [ -n "$wait_minutes" ] || [ -n "$until_iso" ] || [ "$watch_count" -gt 0 ] \
     || [ -n "$rule" ] || [ -n "$needs" ]; then
    echo '--reason/--watch/--wait-minutes/--until/--rule/--needs belong to an outcome status, not to verified' >&2; exit 2
  fi
  [ -n "$command_text" ] || { echo '--command is required for verified: the command as your §Verification writes it' >&2; exit 2; }
  case "$exit_code" in
    ''|*[!0-9]*) echo "--exit needs the command's exit status as a number, got: ${exit_code:-nothing}" >&2; exit 2 ;;
  esac
elif [ -n "$exit_code" ] || [ -n "$in_dir" ]; then
  echo "--exit/--in only make sense with verified, not $status" >&2; exit 2
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
# A human step (control-tower phase 41): a needs-human ask with a type. Every
# field is held here, before anything is written — an unknown kind, a missing
# title, a link that is not http(s), a code on the wrong kind, a secret in any
# value — because a declaration the console must repair is one a person never
# sees in time.
if [ -n "$step_act" ]; then
  # `--act` is `--step operator-act` (control-tower phase 121), never beside
  # another kind: two kinds on one step is a session that has not decided.
  if [ -n "$step_kind" ] && [ "$(printf '%s' "$step_kind" | tr 'A-Z' 'a-z')" != operator-act ]; then
    echo "--act is --step operator-act; it cannot ride --step $step_kind — choose one kind" >&2; exit 2
  fi
  step_kind=operator-act
fi
if [ -n "$step_kind" ] || [ -n "$step_flags" ]; then
  [ "$mode" = outcome ] || { echo "--step and its fields belong to a needs-human declaration, not to $status" >&2; exit 2; }
  [ -n "$step_kind" ] || { echo '--title/--open-url/--open-command/--where/--proof/--step-line/--code/--credential/--due-when need --step <kind> (or --act)' >&2; exit 2; }
  [ "$status" = needs-human ] || { echo "--step is valid only with needs-human (a person's turn), not $status" >&2; exit 2; }
  step_kind="$(printf '%s' "$step_kind" | tr 'A-Z' 'a-z')"
  case " $HUMAN_STEP_KINDS " in
    *" $step_kind "*) : ;;
    *) echo "unknown --step kind: $step_kind (want one of: $HUMAN_STEP_KINDS)" >&2; exit 2 ;;
  esac
  [ -n "$step_title" ] || { echo "--title is required with --step: say what the person must do" >&2; exit 2; }
  if [ -n "$step_open_url" ] && [ -n "$step_open_command" ]; then
    echo '--open-url and --open-command are one or the other: a step opens a link OR runs a command' >&2; exit 2
  fi
  if [ -n "$step_open_url" ]; then
    printf '%s' "$step_open_url" | grep -qiE '^https?://[^[:space:]/?#]+[^[:space:]]*$' \
      || { echo "--open-url must be an http or https link; anything else is never opened" >&2; exit 2; }
  fi
  if [ -z "$step_where" ]; then
    for pair in $HUMAN_STEP_DEFAULT_WHERE; do
      [ "${pair%%:*}" = "$step_kind" ] && step_where="${pair#*:}"
    done
  fi
  step_where="$(printf '%s' "$step_where" | tr 'A-Z' 'a-z')"
  case " $HUMAN_STEP_WHERE " in
    *" $step_where "*) : ;;
    *) echo "unknown --where: $step_where (want one of: $HUMAN_STEP_WHERE)" >&2; exit 2 ;;
  esac
  if [ -n "$step_code" ]; then
    [ "$step_kind" = device-code ] || { echo "--code belongs to a device-code step, not $step_kind" >&2; exit 2; }
    printf '%s' "$step_code" | grep -qE '^[A-Z0-9]{4,9}(-[A-Z0-9]{4,9})?$' \
      || { echo '--code must be a short device code (ABCD-1234); a longer value is not one' >&2; exit 2; }
  fi
  if [ "$step_kind" = secret-entry ]; then
    [ -n "$step_credential" ] || { echo '--credential <id> is required with --step secret-entry: the registry id the secret is stored under' >&2; exit 2; }
  elif [ -n "$step_credential" ]; then
    echo "--credential belongs to a secret-entry step, not $step_kind" >&2; exit 2
  fi
  if [ -n "$step_credential" ]; then
    printf '%s' "$step_credential" | grep -qE '^[a-z0-9][a-z0-9._-]{0,63}$' \
      || { echo "--credential must be a registry id (a-z, 0-9, . _ -, at most 64): $step_credential" >&2; exit 2; }
  fi
  if [ -n "$step_proof" ]; then
    [ "${#step_proof}" -le "$WATCH_REF_MAX" ] || { echo "--proof is longer than $WATCH_REF_MAX characters" >&2; exit 2; }
    proof_problem="$(_cmd_ref_problem "$step_proof")"
    [ -z "$proof_problem" ] || { echo "--proof refused: $proof_problem" >&2; exit 2; }
  fi
  # The moment the step becomes due (control-tower phase 121): a watch ref the
  # console polls. One it could never probe would leave the step `upcoming`
  # for ever — never pushed, never due — so it is refused here, while the
  # session can still fix it.
  if [ -n "$step_due_when" ]; then
    [ "${#step_due_when}" -le "$WATCH_REF_MAX" ] || { echo "--due-when refused: longer than $WATCH_REF_MAX characters" >&2; exit 2; }
    due_problem="$(_watch_problem "$step_due_when")"
    [ -z "$due_problem" ] && case "$step_due_when" in cmd:*) due_problem="$(_cmd_ref_problem "$step_due_when")" ;; esac
    [ -z "$due_problem" ] && _own_lock_ref "$step_due_when" && due_problem="it names this phase's own lock, which is released only when the phase ends"
    [ -z "$due_problem" ] || { echo "--due-when refused: $due_problem. Nothing was written." >&2; exit 2; }
    _screen_secret --due-when "$step_due_when"
  fi
  _screen_secret --title "$step_title"
  _screen_secret --open-url "$step_open_url"
  _screen_secret --open-command "$step_open_command"
  _screen_secret --proof "$step_proof"
  _screen_secret --reason "$reason"
fi
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

# A date beside a live ref is a BACKSTOP (control-tower phase 121, #181): the
# live ref wakes the phase the moment it lands, and the date — a `date:` ref or
# `--until` — only bounds the wait. Said, so the session knows the two are not
# alternatives it must choose between.
case "$status" in
  waiting-external|blocked|needs-human)
    _live=""; _date=""
    while IFS= read -r _ref; do
      [ -z "$_ref" ] && continue
      case "$_ref" in date:*|until:*) [ -z "$(_watch_problem "$_ref")" ] && _date="$_ref" ;; *) _live="${_live:+$_live, }$_ref" ;; esac
    done <<EOF_REFS
$watch_refs
EOF_REFS
    [ -z "$_date" ] && [ -n "$until_iso" ] && _date="--until $until_iso"
    if [ -n "$_live" ] && [ -n "$_date" ]; then
      echo "note: $_date is the backstop: it only bounds the wait — $_live wakes the phase the moment it lands" >&2
    fi
    ;;
esac

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

# ---- progress: one line on the task channel, and nothing else happens ------
if [ "$mode" = progress ]; then
  session_json="$( [ -n "$session" ] && printf ',"session_id":"%s"' "$session" || true )"
  line="{\"version\":1,\"type\":\"progress\",\"slug\":\"$(_json_str "$slug")\",\"phase\":$phase,\"label\":\"$(_json_str "$label")\",\"done\":$done_n,\"of\":$of_n,\"written_at\":\"$(_json_str "$now")\"${session_json}}"
  if [ -n "${PE_TASKS_FILE:-}" ]; then
    target="$PE_TASKS_FILE"
  else
    target="$(pe_runs_dir "$(pe_instance_root)" "$slug")/tasks/phase-$(printf '%02d' "$phase").ndjson"
    echo "note: PE_TASKS_FILE is not set (no runner is supervising this session) — recorded for the console at $target" >&2
  fi
  if mkdir -p "$(dirname "$target")" 2>/dev/null && printf '%s\n' "$line" >> "$target" 2>/dev/null; then
    echo "progress recorded: $slug phase $phase — $label $done_n/$of_n"
  else
    echo "note: $target could not be written — printing the progress line only" >&2
    printf '%s\n' "$line"
  fi
  exit 0
fi

# ---- verified: one appended proof line, and nothing else happens -----------
# The tree is computed in a PRIVATE index — the real one copied (so only what
# changed is re-hashed), every change added, the result written as a tree
# object. The session's own index, its staged work and HEAD are never touched;
# the objects written are ordinary unreferenced ones git collects in its time.
if [ "$mode" = proof ]; then
  # The working tree of the repository at <top>, written as a tree object.
  _proof_tree() {  # _proof_tree <top>
    local at="$1" real_index scratch out=""
    # A linked worktree's index lives under the main repository's git dir, which
    # `--git-path` knows; it answers relative to where it was asked.
    real_index="$(cd "$at" && git rev-parse --git-path index 2>/dev/null || true)"
    case "$real_index" in ''|/*) : ;; *) real_index="$at/$real_index" ;; esac
    scratch="$(mktemp "${TMPDIR:-/tmp}/pe-proof-index.XXXXXX")"
    # `-p` keeps the index file's mtime, and that is load-bearing: git trusts an
    # entry's stat data only when the entry is OLDER than the index file, and
    # re-reads the content of one that is not (its racy-clean check). A copy with a
    # fresh mtime makes a file rewritten at the same size in the same second it was
    # staged look unchanged, and the tree would name what was staged, not what ran.
    if [ -n "$real_index" ] && [ -f "$real_index" ]; then cp -p "$real_index" "$scratch"; else rm -f "$scratch"; fi
    if GIT_INDEX_FILE="$scratch" git -C "$at" add -A >/dev/null 2>&1; then
      out="$(GIT_INDEX_FILE="$scratch" git -C "$at" write-tree 2>/dev/null || true)"
    fi
    rm -f "$scratch"
    printf '%s' "$out"
  }
  # The run root (control-tower phase 106, #196): $PE_RUN_ROOT, which the runner
  # injects, else the lock's $PE_WORKTREE, else the OUTERMOST superproject of the
  # checkout this shell stands in. ai-builder-v7 P14's session recorded `--in .`
  # from a shell standing INSIDE a submodule: its proofs were keyed by the
  # submodule's tree, while the console judges those lines — `cd <sub> && …` —
  # at the plan root, against the superproject's. A relative --in is therefore
  # resolved against the run root and never against $PWD.
  run_root="${PE_RUN_ROOT:-${PE_WORKTREE:-}}"
  if [ -z "$run_root" ] || [ ! -d "$run_root" ]; then
    # instance.sh's walk, never a private copy (tests/integration/gitroot.bats).
    run_root="$(pe_outer_checkout . 2>/dev/null || true)"
  fi
  # Where the console JUDGES this phase's lines: $PE_VERIFY_DIR when a console
  # supervises the session — its own answer — else the run root moved by the
  # plan's `Verify in:` (`phase-graph.sh --verify-in`), when the plan reads.
  judge_dir="${PE_VERIFY_DIR:-}"
  [ -n "$judge_dir" ] && [ ! -d "$judge_dir" ] && judge_dir=""
  if [ -n "$in_dir" ]; then
    case "$in_dir" in
      /*) where="$in_dir" ;;
      *)  where="${run_root:-.}/$in_dir" ;;
    esac
  elif [ -n "$judge_dir" ]; then
    where="$judge_dir"
  elif [ -n "$run_root" ]; then
    verify_in="$("$SCRIPT_DIR/phase-graph.sh" "$slug" --verify-in "$phase" 2>/dev/null | head -1 || true)"
    where="$run_root"
    if [ -n "$verify_in" ] && [ -d "$run_root/$verify_in" ]; then where="$run_root/$verify_in"; fi
  else
    where="."
  fi
  top="$(git -C "$where" rev-parse --show-toplevel 2>/dev/null || true)"
  if [ -z "$top" ]; then
    echo "not recorded: $where is not inside a git working tree, so there is no tree to prove against" >&2
    exit 2
  fi
  tree="$(_proof_tree "$top")"
  if [ -z "$tree" ]; then
    echo "not recorded: git could not write the working tree of $top as a tree object" >&2
    exit 2
  fi
  # A proof the verdict could only refuse is refused NOW, while the session can
  # still record it where its lines are judged: a tree that is not an object of
  # the repository the console judges in ("not an object of this repository")
  # was refused at the verdict and the line re-run — ~15 minutes on ai-builder-v7
  # P14, the lane held throughout. Only where that repository is KNOWN — a
  # console told the session ($PE_VERIFY_DIR); unsupervised, the verdict judges.
  if [ -n "$judge_dir" ]; then
    judge_top="$(git -C "$judge_dir" rev-parse --show-toplevel 2>/dev/null || true)"
    if [ -n "$judge_top" ] && [ "$(cd "$judge_top" && pwd -P)" != "$(cd "$top" && pwd -P)" ] \
       && ! git -C "$judge_top" cat-file -e "${tree}^{tree}" 2>/dev/null; then
      judge_tree="$(_proof_tree "$judge_top")"
      echo "not recorded: the tree ${tree:0:12} (the working tree of $top, where --in pointed) is not an object of $judge_top — where the console judges phase $phase's lines, whose tree is ${judge_tree:0:12} — so the verdict would refuse it and run the line again. Record it where the line is judged: drop --in, or give one relative to the run root ($run_root)." >&2
      exit 2
    fi
  fi
  head_sha="$(git -C "$top" rev-parse -q --verify HEAD 2>/dev/null || true)"
  # Folded exactly as the console folds a §Verification command before it
  # compares (`commandFingerprint`): markdown wrapping is not a new command.
  command_text="$(printf '%s' "$command_text" | tr '\n\t' '  ' | tr -s ' ' | sed 's/^ //; s/ $//')"
  head_json="$( [ -n "$head_sha" ] && printf ',"head":"%s"' "$head_sha" || true )"
  session_json="$( [ -n "$session" ] && printf ',"session_id":"%s"' "$session" || true )"
  line="{\"version\":1,\"type\":\"proof\",\"slug\":\"$(_json_str "$slug")\",\"phase\":$phase,\"command\":\"$(_json_str "$command_text")\",\"code\":$((10#$exit_code)),\"tree\":\"$tree\"${head_json},\"at\":\"$(_json_str "$now")\"${session_json}}"
  if [ -n "${PE_PROOFS_FILE:-}" ]; then
    ledger="$PE_PROOFS_FILE"
    if mkdir -p "$(dirname "$ledger")" 2>/dev/null && printf '%s\n' "$line" >> "$ledger" 2>/dev/null; then
      echo "proof recorded: $slug phase $phase — exit $((10#$exit_code)) at tree ${tree:0:12}  ->  $ledger"
    else
      echo "note: $ledger could not be written — printing the proof only; the console will run this command itself" >&2
      printf '%s\n' "$line"
    fi
  else
    root="$(pe_instance_root)"
    ledger="$(pe_runs_dir "$root" "$slug")/proofs.ndjson"
    if mkdir -p "$(dirname "$ledger")" 2>/dev/null && printf '%s\n' "$line" >> "$ledger" 2>/dev/null; then
      echo "note: PE_PROOFS_FILE is not set (no runner is supervising this session) — recorded for the console at $ledger" >&2
    else
      echo "note: PE_PROOFS_FILE is not set and $ledger could not be written — printing the proof only" >&2
    fi
    printf '%s\n' "$line"
  fi
  exit 0
fi

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
step_line=""
if [ -n "$step_kind" ]; then
  step_line="
  \"step\": {\"kind\": \"$step_kind\", \"title\": \"$(_json_str "$(printf '%s' "$step_title" | cut -c1-300)")\""
  [ -n "$step_open_url" ] && step_line="$step_line, \"open_url\": \"$(_json_str "$step_open_url")\""
  [ -n "$step_open_command" ] && step_line="$step_line, \"open_command\": \"$(_json_str "$(printf '%s' "$step_open_command" | cut -c1-500)")\""
  step_line="$step_line, \"where\": \"$step_where\""
  [ -n "$step_proof" ] && step_line="$step_line, \"proof\": \"$(_json_str "$step_proof")\""
  [ "$step_line_count" -gt 0 ] && step_line="$step_line, \"lines\": [$step_lines_json]"
  [ -n "$step_code" ] && step_line="$step_line, \"code\": \"$step_code\""
  [ -n "$step_credential" ] && step_line="$step_line, \"credential\": \"$step_credential\""
  [ -n "$step_due_when" ] && step_line="$step_line, \"due_when\": \"$(_json_str "$step_due_when")\""
  step_line="$step_line},"
fi
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
  \"status\": \"$status\",${reason_line}${needs_line}${rule_line}${command_line}${step_line}${resume_line}${session_line}${trace_line}${span_line}
  \"watch\": [$watch_json],
  \"written_at\": \"$(_json_str "$now")\"
}"

# ---- the ingest probe (control-tower phase 50, #86) ---------------------------
# A declaration that PARKS and names refs is staged under a temporary name, and
# the console is asked now — while this session is still here to hear it —
# whether one of its refs has ALREADY landed: 5 of 30 declared refs were true
# when declared, and each still cost a park, a probe and a resume. On "landed"
# the staged file is removed, nothing parks, the console's sentence is printed
# and the exit is 3 (ALREADY_LANDED_EXIT, viewer/server/declared-probe.ts): the
# session carries on with its phase. Anything else — a pending answer, a
# refusal, no console, no curl — moves the staged file into place and the
# declaration parks exactly as it always did. The console reads the refs from
# the staged file, never from this request. PHASE_OUTCOME_PROBE=0 skips it.
landed_sentence=""
refused_sentence=""
# 0 when a ref has already landed, 2 when the console REFUSED one (control-tower
# phase 88, #125: its policy would never run it, so nothing would ever resume
# the phase — exit 2 while the session can still fix it), 1 for anything else.
_probe_declaration() {  # _probe_declaration <staged file>
  local url code reply_file reply
  [ "${PHASE_OUTCOME_PROBE:-1}" != 0 ] || return 1
  case "$status" in waiting-external|blocked|needs-human) ;; *) return 1 ;; esac
  [ -n "$watch_json" ] || return 1
  command -v curl >/dev/null 2>&1 || return 1
  url="$(pe_console_url "$(pe_docs_root)" 2>/dev/null || true)"
  [ -n "$url" ] || return 1
  reply_file="$(mktemp "${TMPDIR:-/tmp}/pe-probe.XXXXXX" 2>/dev/null)" || return 1
  # 25 s against the console's 20 s budget: its answer, not curl's clock, ends it.
  code="$(curl -sS -o "$reply_file" -w '%{http_code}' --connect-timeout 2 --max-time 25 \
      -X POST "$url/hooks/declaration" -H 'content-type: application/json' \
      --data "{\"slug\":\"$(_json_str "$slug")\",\"phase\":$phase,\"file\":\"$(_json_str "$1")\"}" 2>/dev/null || true)"
  reply="$(cut -c1-4000 "$reply_file" 2>/dev/null || true)"; rm -f "$reply_file"
  [ "$code" = 200 ] || return 1
  case "$reply" in
    *'"verdict":"landed"'*) ;;
    *'"verdict":"refused"'*)
      refused_sentence="$(printf '%s' "$reply" | sed -n 's/.*"sentence":"\([^"]*\)".*/\1/p' | head -1)"
      [ -n "$refused_sentence" ] || refused_sentence="refused — the console would never run a watched ref as written, so nothing would ever resume this phase: fix the ref and declare again."
      return 2 ;;
    *) return 1 ;;
  esac
  landed_sentence="$(printf '%s' "$reply" | sed -n 's/.*"sentence":"\([^"]*\)".*/\1/p' | head -1)"
  [ -n "$landed_sentence" ] || landed_sentence="already landed — continue: a watched ref has already landed. Nothing was parked; carry on with the phase."
  return 0
}
_say_landed() {
  printf '%s\n' "$landed_sentence"
  echo "note: exit 3 — nothing was parked and nothing will resume this phase; the wait is over, so carry on (do not stop)" >&2
  exit 3
}
_say_refused() {
  echo "--watch $refused_sentence" >&2
  echo "note: exit 2 — nothing was written and nothing parked; fix the ref (or drop it) and declare again" >&2
  exit 2
}
# Ask, then act on the answer: landed → exit 3, refused → exit 2, else carry on.
_probe_or_carry_on() {  # _probe_or_carry_on <staged file>
  local rc=1
  _probe_declaration "$1" && rc=0 || rc=$?
  [ "$rc" = 1 ] && return 0
  rm -f "$1" 2>/dev/null || true
  [ "$rc" = 0 ] && _say_landed
  _say_refused
}

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
  staged=0
  ( printf '%s\n' "$json" > "$tmp" ) 2>/dev/null && staged=1
  [ "$staged" = 1 ] && _probe_or_carry_on "$tmp"
  if [ "$staged" = 1 ] && mv "$tmp" "$PE_OUTCOME_FILE" 2>/dev/null; then
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
    staged=0
    printf '%s\n' "$json" > "$tmp" 2>/dev/null && staged=1
    # The inbox's watcher reads `phase-NN-<stamp>.json` only, so the staged
    # name is invisible to it until the `mv` — no ingest can race the probe.
    [ "$staged" = 1 ] && _probe_or_carry_on "$tmp"
    if [ "$staged" = 1 ] && mv "$tmp" "$target" 2>/dev/null; then
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
