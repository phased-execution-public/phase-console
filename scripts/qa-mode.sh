#!/usr/bin/env bash
# Set (or unset) a plan's QA switches in docs/plans/<slug>.md — the WRITER for the
# two directives scripts/phase-graph.sh already reads:
#
#   plan-wide   **QA gate:** on|off    in §Session budget         (qa_mode)
#   per phase   - **QA:** on|off       in the ### Phase N block   (qa_phase_directive)
#
# Usage: qa-mode.sh <slug> [--phase N] on|off|inherit
#   on|off    the plan's word without --phase; that one phase's own word with it
#   inherit   delete the phase's bullet so it follows the plan again (--phase only)
#
# Deterministic and idempotent (a second run is byte-identical and does not even
# rewrite the file), atomic tmp+mv, no git — the caller commits. Its only output
# is what `phase-graph.sh <slug> --qa-mode [N]` answers AFTER the edit: the
# read-back is the proof that the bytes written are the bytes the engine reads,
# so whoever called (the console's QA toggle, a session, a person) sees the
# regime the engine will act on rather than this script's claim about it.
#
# ## Why a writer, and why it mirrors the reader line for line
#
# The engine has read both switches since 2026-08-22 — `**QA gate:** off` is the
# one thing that releases a recorded `fail` plan-wide, and the phase bullet is
# what exempts a docs phase or singles out the one that touches money — and the
# only writer was a text editor. The console's "turn QA on" reached qa-record.sh,
# which switches QA on as a SIDE EFFECT (the table now exists, so the back-compat
# rule says on) and has no way to say off, or to speak for one phase. Those were
# hand edits to the file the autopilot re-reads at every board, and a toggle in a
# browser cannot be a hand edit. A hand edit stays valid: this writes the shape
# the reader accepts and nothing the reader does not.
#
# So the patterns below are the engine's own, transcribed. The plan line is the
# bold-exact `**QA gate:**` at the start of the line behind an optional `> ` or
# `- `, then `on`/`off`, then anything (`qa_mode`; §Session budget runs to the
# next `##` heading, an H3 included, as `session_budget_block` scopes it). The
# phase bullet is `- **QA:** on|off` in the block `phase_block` cuts — from the
# `### Phase N` heading to the next `##` heading — and it is read as SILENCE the
# moment anything follows the word. Every rule here follows from one of those:
#
#   - The plan line's value is replaced on EVERY canonical line in §Session
#     budget, prefix and trailing note kept. `qa_mode` greps for `off` before
#     `on` across the whole section, so one leftover `off` would beat a freshly
#     written `on`.
#   - With no canonical line, `**QA gate:** <mode>` goes in as the section's
#     first line, after the blank that follows the heading, so it is read before
#     any legacy waiver prose (`qa_mode` rule 3) and the operator's own words
#     stay. With no section at all, one is added above `## Phases` — the plan-
#     wide switch just above the blocks it governs, the shape of the fixture
#     qa-per-phase.md — else at the end of the file, the shape qa-mode.bats has
#     always appended and the engine has always read. Never above `## Phase
#     graph`, the one heading the table parser anchors on.
#   - The phase bullet is rewritten as `<prefix>**QA:** <mode>` with everything
#     after the word DROPPED, because a trailing note is precisely what makes
#     `qa_phase_directive` read it as silence. Absent, it goes in right after the
#     heading (after any blank line, and followed by one when what comes next is
#     prose rather than a bullet, so it never swallows a paragraph as a lazy
#     continuation). `inherit` deletes every such bullet in the block: the reader
#     takes the first it finds, so leaving a second would leave the phase speaking.
#   - The write is read back through the engine and compared with what was
#     asked; a disagreement is exit 1 and names the file. It cannot happen while
#     the rules above hold, which is the point: it is the alarm for the day one
#     side changes without the other.
set -euo pipefail
usage="usage: qa-mode.sh <slug> [--phase N] on|off|inherit"
slug="${1:?$usage}"
shift
phase=""; mode=""
while [ $# -gt 0 ]; do
  case "$1" in
    --phase) phase="${2:?--phase needs a number}"; shift 2 ;;
    -*) echo "unknown option: $1" >&2; echo "$usage" >&2; exit 2 ;;
    *)
      [ -z "$mode" ] || { echo "one mode only, got: $mode and $1" >&2; exit 2; }
      mode="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"; shift ;;
  esac
done
case "$mode" in
  on|off) : ;;
  inherit)
    # A plan has nothing to inherit FROM: `inherit` is the phase saying nothing,
    # and the plan-wide switch has no "say nothing" — its absence is `off`.
    [ -n "$phase" ] || { echo "inherit needs --phase N: it deletes a phase's own bullet, and the plan has nothing to inherit from" >&2; exit 2; } ;;
  '') echo "$usage" >&2; exit 2 ;;
  *)  echo "invalid mode: $mode (want on|off|inherit)" >&2; exit 2 ;;
esac
if [ -n "$phase" ]; then
  case "$phase" in ''|*[!0-9]*) echo "phase must be a number, got: $phase" >&2; exit 2 ;; esac
  phase=$((10#$phase))   # `08` is a handoff filename, not a number — normalise once
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/instance.sh"
DOCS_ROOT="$(pe_docs_root)"; export DOCS_ROOT
f="$DOCS_ROOT/docs/plans/$slug.md"
[ -f "$f" ] || { echo "no such plan: $f" >&2; exit 2; }

# The rewrite lands only when it changed something. A no-op toggle that still
# replaced the file would wake every watcher of docs/ — the console converges on
# a docs change — for a plan whose bytes did not move.
commit() {  # commit <tmp>
  if cmp -s "$1" "$f"; then rm -f "$1"; else mv "$1" "$f"; fi
}
tmp="$f.tmp.$$"

if [ -z "$phase" ]; then
  # ---- plan-wide: the §Session budget line ----------------------------------
  # none: no section · absent: a section with no canonical line · present.
  state="$(awk '
    tolower($0) ~ /^##[[:space:]]+session budget/ { has=1; insec=1; next }
    /^##[[:space:]]/ { insec=0 }
    insec && tolower($0) ~ /^[[:space:]>]*([-*][[:space:]]+)?\*\*qa gate:\*\*[[:space:]]*(on|off)([[:space:]]|$)/ { found=1 }
    END { print (has ? (found ? "present" : "absent") : "none") }
  ' "$f")"
  case "$state" in
    present)
      awk -v mode="$mode" '
        # Everything up to and including the bold token stays as written (its
        # case too); the whitespace after it stays; the word is swapped; the
        # rest of the line — a note, a comment — follows untouched.
        function flip(line,   low, p, head, rest, ws, tail) {
          low = tolower(line)
          p = index(low, "**qa gate:**")
          head = substr(line, 1, p + 11); rest = substr(line, p + 12)
          match(rest, /^[[:space:]]*/); ws = substr(rest, 1, RLENGTH)
          match(tolower(rest), /^[[:space:]]*(on|off)/); tail = substr(rest, RLENGTH + 1)
          return head ws mode tail
        }
        tolower($0) ~ /^##[[:space:]]+session budget/ { insec=1; print; next }
        /^##[[:space:]]/ { insec=0 }
        insec && tolower($0) ~ /^[[:space:]>]*([-*][[:space:]]+)?\*\*qa gate:\*\*[[:space:]]*(on|off)([[:space:]]|$)/ { print flip($0); next }
        { print }
      ' "$f" > "$tmp" ;;
    absent)
      awk -v mode="$mode" '
        tolower($0) ~ /^##[[:space:]]+session budget/ && !done { print; pend=1; done=1; next }
        pend && /^[[:space:]]*$/ { print; next }
        pend { print "**QA gate:** " mode; pend=0 }
        { print }
        END { if (pend) print "**QA gate:** " mode }
      ' "$f" > "$tmp" ;;
    none)
      awk -v mode="$mode" '
        BEGIN { prevblank=1 }
        !done && tolower($0) ~ /^##[[:space:]]+phases[[:space:]]*$/ {
          if (!prevblank) print ""
          print "## Session budget"; print ""; print "**QA gate:** " mode; print ""
          done=1
        }
        { print; prevblank = ($0 ~ /^[[:space:]]*$/) }
        END { if (!done) { if (!prevblank) print ""; print "## Session budget"; print ""; print "**QA gate:** " mode } }
      ' "$f" > "$tmp" ;;
  esac
  commit "$tmp"
else
  # ---- per phase: the ### Phase N bullet ------------------------------------
  # none: no such heading · absent: a block with no bullet · present. The block
  # is cut exactly as phase_block cuts it, heading match and all, so a phase
  # this cannot find is a phase the engine could not read a word for either.
  state="$(awk -v want="$phase" '
    /^###[[:space:]]+[Pp]hase[[:space:]]+[0-9]+/ {
      h=$0; sub(/^###[[:space:]]+[Pp]hase[[:space:]]+/,"",h); sub(/[^0-9].*/,"",h)
      cur=(h==want)?1:0; if (cur) has=1
    }
    /^##[[:space:]]/ && cur { cur=0 }
    cur && tolower($0) ~ /^[[:space:]]*[-*][[:space:]]*\*\*qa:?\*\*/ { found=1 }
    END { print (has ? (found ? "present" : "absent") : "none") }
  ' "$f")"
  [ "$state" != none ] || {
    echo "phase $phase: no \"### Phase $phase\" section in $f — the engine reads a phase's QA word from that block, so there is nowhere to write one" >&2
    exit 2
  }
  case "$mode:$state" in
    inherit:*)
      awk -v want="$phase" '
        /^###[[:space:]]+[Pp]hase[[:space:]]+[0-9]+/ {
          h=$0; sub(/^###[[:space:]]+[Pp]hase[[:space:]]+/,"",h); sub(/[^0-9].*/,"",h)
          cur=(h==want)?1:0
        }
        /^##[[:space:]]/ && cur { cur=0 }
        cur && tolower($0) ~ /^[[:space:]]*[-*][[:space:]]*\*\*qa:?\*\*/ { next }
        { print }
      ' "$f" > "$tmp" ;;
    *:present)
      awk -v want="$phase" -v mode="$mode" '
        # The prefix is whatever the engine matched — indent, marker, the bold
        # token as written — and the rest of the line is the word alone.
        function setb(line) {
          match(tolower(line), /^[[:space:]]*[-*][[:space:]]*\*\*qa:?\*\*/)
          return substr(line, 1, RLENGTH) " " mode
        }
        /^###[[:space:]]+[Pp]hase[[:space:]]+[0-9]+/ {
          h=$0; sub(/^###[[:space:]]+[Pp]hase[[:space:]]+/,"",h); sub(/[^0-9].*/,"",h)
          cur=(h==want)?1:0
        }
        /^##[[:space:]]/ && cur { cur=0 }
        cur && !done && tolower($0) ~ /^[[:space:]]*[-*][[:space:]]*\*\*qa:?\*\*/ { print setb($0); done=1; next }
        { print }
      ' "$f" > "$tmp" ;;
    *:absent)
      awk -v want="$phase" -v mode="$mode" '
        /^###[[:space:]]+[Pp]hase[[:space:]]+[0-9]+/ && !done {
          h=$0; sub(/^###[[:space:]]+[Pp]hase[[:space:]]+/,"",h); sub(/[^0-9].*/,"",h)
          if (h==want) { print; pend=1; done=1; next }
        }
        pend && /^[[:space:]]*$/ { print; next }
        pend { print "- **QA:** " mode; if ($0 !~ /^[[:space:]]*[-*][[:space:]]/) print ""; pend=0 }
        { print }
        END { if (pend) print "- **QA:** " mode }
      ' "$f" > "$tmp" ;;
  esac
  commit "$tmp"
fi

# ---- the read-back ------------------------------------------------------------
if [ -n "$phase" ]; then
  answer="$("$SCRIPT_DIR/phase-graph.sh" "$slug" --qa-mode "$phase")" \
    || { echo "qa-mode.sh: the edit is written, but phase-graph.sh could not read $f back (see above)" >&2; exit 1; }
else
  answer="$("$SCRIPT_DIR/phase-graph.sh" "$slug" --qa-mode)" \
    || { echo "qa-mode.sh: the edit is written, but phase-graph.sh could not read $f back (see above)" >&2; exit 1; }
fi
# What the engine must now say, in its own words: the plan-wide `off` reads as
# `waived`, and a phase that inherits names no phase directive at all.
ok=0
case "$phase:$mode" in
  :on)       case "$answer" in "on (plan directive"*)      ok=1 ;; esac ;;
  :off)      case "$answer" in "waived (plan directive"*)  ok=1 ;; esac ;;
  *:on)      case "$answer" in "on (phase directive"*)     ok=1 ;; esac ;;
  *:off)     case "$answer" in "off (phase directive"*)    ok=1 ;; esac ;;
  *:inherit) case "$answer" in *"phase directive"*) ;; *)  ok=1 ;; esac ;;
esac
[ "$ok" -eq 1 ] || {
  echo "qa-mode.sh: wrote ${phase:+phase $phase }QA $mode, but phase-graph.sh --qa-mode reads \"$answer\" — $f carries a QA directive this script did not write; edit it by hand" >&2
  exit 1
}
printf '%s\n' "$answer"
exit 0
