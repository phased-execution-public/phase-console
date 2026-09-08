#!/usr/bin/env bash
# Deterministic repair of a plan's WORK-STATE artefacts — the free first rung of
# `plan-broken`.
#
# Four things go wrong with a plan's bookkeeping that need no judgement to put
# right, and until this script existed the ladder reached straight for a paid
# agent session to do them:
#
# REPAIRED (counted as `changed`):
#   index-drift   an INDEX.md status cell disagrees with the handoff it links to
#   depends-drift a handoff's `depends_on:` disagrees with the plan graph
#   expired-lock  a lock whose lease has passed is still on disk
#   not-started   a `blocked` handoff written by an attempt that never ran
#
# REPORTED AND REFUSED (counted as `declined`, never `changed` — the caller
# settles its ladder rung `fixed` on `changed`, so a refusal counted there once
# recorded a repair that had not happened and deleted the errand a person
# needed):
#   index-unreadable  the handoff is named in INDEX.md but not in a table row
#   depends-declined  the graph answers "no dependencies", which is also its
#                     answer for a phase it does not have — see the guard below
#   phase-unreadable  the handoff's `phase:` is missing or not a number
#
# Each has exactly ONE right answer, and each answer is computable — the
# frontmatter for the first, `phase-graph.sh --deps` for the second, the clock
# for the third, and the RUN's own `attempts === 0` for the fourth (which is why
# the fourth is only ever done for phases the caller NAMES: a `blocked` handoff
# is testimony, and only the run knows whether anything wrote it).
#
# 🚫 What it must never do, because these are the repairs that ARE judgement:
# it never edits the plan file, never edits a handoff BODY, never invents a
# status the repository does not support, and never touches a handoff that is
# not already wrong. A repair that guesses is worse than an errand.
#
# Usage: repair-artefacts.sh <slug> [--apply] [--reset-not-started N[,N…]]…
#   Without --apply it only REPORTS (the dry run is the default, so a console
#   can show a diff before spending anything).
# Output: one JSON object on stdout — the summary the runner reads.
# Exit:   0 = ran (whether or not anything changed) · 2 = usage.
#
# bash 3.2 (macOS system bash) — no associative arrays, no `sed -i`.

# Deliberately NOT `set -e`: this script's whole job is to survive artefacts
# that are malformed, and a `grep` that finds nothing is the NORMAL case here.
# `validate.sh` was killed mid-loop by exactly that (a handoff with no
# `depends_on` line), exiting non-zero with nothing printed — the silent-red
# shape a repair tool must never take. Every failure below is handled where it
# happens, and the JSON summary is always printed.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BASH_BIN="${BASH:-bash}"

usage() {
  echo 'usage: repair-artefacts.sh <slug> [--apply] [--reset-not-started N[,N…]]' >&2
  exit 2
}

[ $# -ge 1 ] || usage
slug="$1"; shift
case "$slug" in -*|'') usage ;; esac

apply=0
reset_list=' '
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) apply=1; shift ;;
    --reset-not-started)
      [ $# -ge 2 ] || { echo '--reset-not-started needs a phase number' >&2; exit 2; }
      # CSV or repeated; kept as a space-padded string so a 3.2 shell can ask
      # `case "$reset_list" in *" $n "*)` without an associative array.
      for n in $(printf '%s' "$2" | tr ',' ' '); do
        case "$n" in
          ''|*[!0-9]*) echo "--reset-not-started wants phase numbers, got: $n" >&2; exit 2 ;;
        esac
        reset_list="$reset_list$n "
      done
      shift 2 ;;
    *) echo "unknown option: $1" >&2; usage ;;
  esac
done

# shellcheck source=/dev/null
. "$SCRIPT_DIR/instance.sh"
DOCS_ROOT="$(pe_docs_root)"

ho_dir="$DOCS_ROOT/docs/handoffs/$slug"
index="$ho_dir/INDEX.md"
changed=0
declined=0
rows=''

# One repair, as a JSON object appended to the array.
#
# 🔴 TWO counters, not one. `changed` counts repairs this run actually MADE;
# `declined` counts the ones it reported and refused (an unreadable INDEX row, a
# `depends_on` it will not empty). Folding them was measurably harmful in the
# harmful direction: the driver settles the rung `fixed` when `changed > 0` and
# `validate.sh` passes, so a refusal on an already-green plan made the ladder
# record a repair that had not happened, stamp `slot.fixed`, and DELETE the
# errand a person needed. A row this script declined to act on is evidence, not
# work.
#
# `applied` is the DRY-RUN distinction and is now honest for both: a declined
# row is never `applied`, whatever `--apply` says.
# Every row kind this script emits, split by what the kind MEANS. Spelled out
# rather than matched by a `*-declined|*-unreadable` glob: which counter a kind
# feeds decides whether the ladder records a repair as `fixed`, and a future
# kind picking its counter from how somebody happened to name it is a silent
# way to get that wrong. A kind in neither list is treated as DECLINED — the
# safe side, since over-counting `changed` is what promoted a refusal to a fix.
REPAIRED_KINDS=' index-drift depends-drift not-started expired-lock '
DECLINED_KINDS=' index-unreadable depends-declined phase-unreadable '

emit() {
  local kind="$1" phase="$2" from="$3" to="$4" note="${5:-}"
  local row applied=false counter=declined
  case "$REPAIRED_KINDS" in
    *" $kind "*) counter=changed; [ "$apply" -eq 1 ] && applied=true ;;
    *)
      # In neither list: counted as DECLINED (the safe side — over-counting
      # `changed` is what promoted a refusal to a fix) and SAID, so an
      # unregistered kind cannot quietly pick a counter. Both lists are read
      # here, which is what keeps them a real declaration rather than a comment.
      case "$DECLINED_KINDS" in
        *" $kind "*) : ;;
        *) note="${note:+$note; }BUG: '$kind' is in neither REPAIRED_KINDS nor DECLINED_KINDS — counted as declined" ;;
      esac
      ;;
  esac
  # 🔴 Base-10 normalised, ALWAYS. A handoff carrying `phase: 007` interpolated
  # raw makes `"phase":007` — invalid JSON — and the caller's `JSON.parse` then
  # throws into a `catch` that reads the whole run as "changed 0", settling the
  # rung "found nothing to fix" immediately after applying real repairs. The
  # same `$((10#$n))` guard `phase-outcome.sh` already carries, for the same
  # reason. A non-numeric phase becomes 0 rather than breaking the document.
  case "$phase" in ''|*[!0-9]*) phase=0 ;; *) phase=$((10#$phase)) ;; esac
  row="{\"kind\":\"$kind\",\"phase\":$phase,\"from\":$(json_str "$from"),\"to\":$(json_str "$to"),\"applied\":$applied"
  [ -n "$note" ] && row="$row,\"note\":$(json_str "$note")"
  row="$row}"
  if [ -z "$rows" ]; then rows="$row"; else rows="$rows,$row"; fi
  if [ "$counter" = declined ]; then declined=$((declined + 1)); else changed=$((changed + 1)); fi
}

# Minimal JSON string escaping — backslash, quote, and the control characters a
# lock owner or a status cell could plausibly carry.
json_str() {
  printf '"%s"' "$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/	/\\t/g' | tr -d '\n\r')"
}

# A frontmatter scalar, comment stripped. Only the FIRST block: a body line that
# happens to start with `status:` is not frontmatter.
front_field() {
  awk -v key="$2" '
    { sub(/\r$/, "") }   # a CRLF handoff is a handoff; without this every field
                         # read empty, every repair skipped, and the script
                         # answered "changed: 0" about a file it could not read
    NR == 1 && $0 == "---" { infm = 1; next }
    infm && $0 == "---" { exit }
    infm && index($0, key ":") == 1 {
      sub("^" key ":[ \t]*", ""); sub("[ \t]*#.*$", ""); print; exit
    }
  ' "$1" 2>/dev/null
}

summary() {
  printf '{"slug":%s,"applied":%s,"changed":%s,"declined":%s,"repairs":[%s]}\n' \
    "$(json_str "$slug")" "$([ "$apply" -eq 1 ] && echo true || echo false)" "$changed" "$declined" "$rows"
}

if [ ! -d "$ho_dir" ]; then summary; exit 0; fi

# ------------------------------------------------------------------ #
# 1 + 2 + 4 — per handoff: INDEX cell, depends_on, the not-started marker
# ------------------------------------------------------------------ #
for f in "$ho_dir"/phase-*.md; do
  [ -e "$f" ] || continue
  base="$(basename "$f")"
  st="$(front_field "$f" status)"
  ph="$(front_field "$f" phase)"
  case "$ph" in
    ''|*[!0-9]*)
      # Reported rather than skipped in silence — the same class L-1 and L-2
      # were taught to break. Without a phase number the depends_on and
      # not-started repairs cannot run at all, and answering `changed: 0` about
      # a file we could not read is the shape this script exists to remove.
      # BOTH shapes are reported: a `phase:` that is not a number, and a
      # frontmatter with no `phase:` line at all (which an empty `$ph` is).
      # One arm or the other, never both: `${ph:+a}${ph:-b}` concatenates when
      # `$ph` is set, which printed "the frontmatter phase is not a numbertwo".
      if [ -n "$ph" ]; then _why="is not a number ('$ph')"; else _why="is missing"; fi
      emit phase-unreadable 0 "${ph:-(absent)}" "" \
        "$base: the frontmatter phase $_why, so this handoff was not repaired"
      ph=''
      ;;
  esac

  # --- 4. a `blocked` marker from an attempt that never started -------------
  # Only for a phase the CALLER named: `record.attempts === 0` is a fact about
  # the run, which this script cannot see. `pending` is the honest word — the
  # board reads it as not-started, which is what actually happened — and it is
  # one of the four frozen handoff statuses, so nothing downstream has to learn
  # a new one.
  if [ -n "$ph" ] && [ "$st" = blocked ]; then
    case "$reset_list" in
      *" $ph "*)
        emit not-started "$ph" blocked pending "nothing ran for this phase, so its blocked marker is not testimony"
        if [ "$apply" -eq 1 ]; then
          awk '
            NR == 1 && $0 == "---" { infm = 1; print; next }
            infm && $0 == "---" { infm = 0; print; next }
            infm && index($0, "status:") == 1 { sub(/status:[ \t]*blocked/, "status: pending"); print; next }
            { print }
          ' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
          st=pending
        fi
        ;;
    esac
  fi

  # --- 1. the INDEX status cell --------------------------------------------
  # Matched on the LINK, never on the phase number: two rows can share a number
  # after a rename, and only one of them points at this file.
  if [ -f "$index" ] && [ -n "$st" ]; then
    # A TABLE ROW, not merely a line mentioning the link: prose above the table
    # ("phase-02-two.md is the one to read first") has no field 4, so `cur` came
    # back empty and the real drift below it was neither repaired NOR reported —
    # silence that reads exactly like "nothing was wrong".
    cur="$(awk -v want="($base)" -F'|' '
      /^[ \t]*\|/ && index($0, want) { gsub(/^[ \t]+|[ \t]+$/, "", $4); print $4; exit }
    ' "$index" 2>/dev/null)"
    if [ -z "$cur" ] && grep -qF "($base)" "$index" 2>/dev/null; then
      # Named in the file but not in any table row we can read. Reported, never
      # guessed at: an INDEX shape this script does not understand is a person's.
      emit index-unreadable "${ph:-0}" "$base" "$st" "named in INDEX.md but not in a table row this script can read"
    elif [ -n "$cur" ] && [ "$cur" != "$st" ]; then
      emit index-drift "${ph:-0}" "$cur" "$st" "$base"
      if [ "$apply" -eq 1 ]; then
        awk -v want="($base)" -v to="$st" -F'|' -v OFS='|' '
          /^[ \t]*\|/ && index($0, want) && !done { $4 = " " to " "; done = 1 }
          { print }
        ' "$index" > "$index.tmp" && mv "$index.tmp" "$index"
      fi
    fi
  fi

  # --- 2. depends_on vs the plan graph -------------------------------------
  # The graph is the source of truth for dependencies (REPAIR_ADVICE says so to
  # the agent; this says it to the machine). `--deps` failing means the engine
  # could not read the plan at all — a judgement repair, not this one's.
  if [ -n "$ph" ]; then
    # Two steps on purpose: the engine's EXIT CODE is the only thing that tells
    # "phase 1 depends on nothing" from "the plan could not be read", and both
    # print an empty line. Folding them would have this script rewrite every
    # handoff to `[]` the moment the plan table broke — the exact class of
    # confident wrong repair it must not make.
    deps_raw="$(DOCS_ROOT="$DOCS_ROOT" "$BASH_BIN" "$SCRIPT_DIR/phase-graph.sh" "$slug" --deps "$ph" 2>/dev/null)"
    deps_ok=$?
    want="$(printf '%s' "$deps_raw" | tr ' ' '\n' | sed '/^$/d' | sort -n | tr '\n' ' ' | sed 's/ *$//')"
    if [ "$deps_ok" -eq 0 ]; then
      raw="$(grep -m1 '^depends_on:' "$f" 2>/dev/null)"
      got="$(printf '%s' "${raw:-}" | sed 's/^depends_on:[[:space:]]*\[//; s/\].*$//; s/,/ /g' \
        | tr ' ' '\n' | sed '/^$/d' | sort -n | tr '\n' ' ' | sed 's/ *$//')"
      # 🔴 An EMPTY answer is two different facts and the engine cannot tell them
      # apart: "this phase depends on nothing" and "this plan has no such phase"
      # both print nothing and exit 0 (measured: `--deps 99` on a 7-phase plan).
      # So a handoff whose `phase:` is wrong — `phase: 007` against a 7-phase
      # plan — would have its real `depends_on: [1]` rewritten to `[]`, and
      # `validate.sh` would then agree with the damage. Emptying a non-empty
      # dependency list is therefore REFUSED and reported instead. Narrowing
      # ([1,2] → [1]) and filling ([] → [1]) are still repaired: neither can be
      # produced by an unknown phase.
      if [ -n "$raw" ] && [ "$want" != "$got" ] && [ -z "$want" ] && [ -n "$got" ]; then
        emit depends-declined "$ph" "[$got]" "[]" \
          "the graph answers 'no dependencies', which is also what it answers for a phase it does not have — refusing to empty a stated list"
      elif [ -n "$raw" ] && [ "$want" != "$got" ]; then
        pretty="$(printf '%s' "$want" | sed 's/ /, /g')"
        emit depends-drift "$ph" "[$got]" "[$pretty]" "$base"
        if [ "$apply" -eq 1 ]; then
          # The trailing comment is part of the template and is kept: this
          # rewrites the VALUE, not the line.
          awk -v to="$pretty" '
            index($0, "depends_on:") == 1 && !done {
              tail = ""
              if (match($0, /#.*$/)) tail = "  " substr($0, RSTART, RLENGTH)
              print "depends_on: [" to "]" tail
              done = 1; next
            }
            { print }
          ' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
        fi
      fi
    fi
  fi
done

# ------------------------------------------------------------------ #
# 3 — locks whose lease has passed
# ------------------------------------------------------------------ #
# Released through phase-lock.sh, never by `rm`: a lock deleted behind its own
# script's back is drift of exactly the kind this file exists to remove.
#
# 🔴 The removal is LOCAL. `--git` is deliberately NOT passed — it would make an
# unattended repair pull, commit and PUSH, and the console's own engine refuses
# to hand `--git` to any script for exactly that reason (`engine.ts`: "refusing
# to run a script with --git"). Where the lock file is tracked, the deletion
# therefore sits in the working tree until somebody commits it, and the summary
# says so per row rather than leaving the caller to assume it was published.
# A LIVE lease is left alone — an expired one is debris, a live one is somebody
# working.
lockdir="$ho_dir/.locks"
if [ -d "$lockdir" ]; then
  now="$(date +%s)"
  for lf in "$lockdir"/phase-*.lock; do
    [ -e "$lf" ] || continue
    lease="$(grep -m1 '^lease_until=' "$lf" 2>/dev/null | sed 's/^lease_until=//')"
    owner="$(grep -m1 '^owner=' "$lf" 2>/dev/null | sed 's/^owner=//')"
    lph="$(grep -m1 '^phase=' "$lf" 2>/dev/null | sed 's/^phase=//')"
    case "$lease" in ''|*[!0-9]*) continue ;; esac
    case "$lph" in ''|*[!0-9]*) continue ;; esac
    [ "$now" -ge "$lease" ] || continue
    emit expired-lock "$lph" "${owner:-unknown}" released \
      "the lease had passed; the removal is LOCAL — this script never passes --git, so commit it to publish it"
    if [ "$apply" -eq 1 ]; then
      DOCS_ROOT="$DOCS_ROOT" "$BASH_BIN" "$SCRIPT_DIR/phase-lock.sh" "$slug" release "$lph" \
        --owner "${owner:-unknown}" --force >/dev/null 2>&1 || true
    fi
  done
fi

summary
exit 0
