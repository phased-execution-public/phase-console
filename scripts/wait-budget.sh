#!/usr/bin/env bash
# Set a plan's wait budget in docs/plans/<slug>.md — the WRITER for the two
# directives scripts/phase-graph.sh already reads (`--wait-budget [N]`):
#
#   plan-wide   **Wait budget:** <max>              in §Session budget        (plan_wait_budget)
#   per phase   - **Waits on:** <ref>[, …] · <max>  in the ### Phase N block  (wait_budget_for_phase)
#
# Usage: wait-budget.sh <slug> [--phase N [--ref REF]…] <max>
#        wait-budget.sh <slug> [--phase N] --count <n>
#   --count   how many waits the phase may DECLARE (control-tower phase 121,
#             #40): `- **Wait count:** <n>` in the ### Phase N block, or the
#             plan's `**Wait count:** <n>` in §Session budget — a whole number
#             1..99; read back through `phase-graph.sh --wait-count [N]`
#   <max>     a duration: `90m`, `2h`, `3d`, or bare minutes (`150`)
#   --phase   that phase's own `Waits on:` max; without it, the plan's line
#   --ref     the refs to name when the phase has NO `Waits on:` bullet yet —
#             the grammar is `<ref>[, <ref>…] · <max>`, so a bullet needs one
#
# Deterministic and idempotent (a second run is byte-identical and does not even
# rewrite the file), atomic tmp+mv, no git — the caller commits. Its only output
# is what `phase-graph.sh <slug> --wait-budget [N]` answers AFTER the edit, so
# whoever called (the console's raise verb, a session, a person) sees the budget
# the engine will act on rather than this script's claim about it.
#
# ## Why a writer (control-tower phase 14, #40)
#
# A phase parked on a spent wait budget told the operator to "extend this phase
# with `- **Waits on:** <ref> · <max>` (or `**Wait budget:**` in §Session
# budget), then Retry" — a good error message and a bad interface: the only
# writer was a text editor. The raise has to land WHERE THE BUDGET WAS
# DECLARED, because the engine re-reads the plan on every board; a run-local
# override would be silently lost on the next read. So this writes the shape
# the reader accepts and nothing the reader does not — the patterns are the
# engine's own, transcribed (`qa-mode.sh` is the precedent):
#
#   - The phase bullet is the FIRST `- **Waits on:**` line in the block
#     `phase_block` cuts (heading to the next phase heading or `##`). Everything
#     before its ` · ` — the refs — stays verbatim. After it, the FIRST duration
#     is replaced (a `~` hugging it goes: a raise is exact) and whatever follows
#     it, a note, stays. With no ` · `, one is appended. With no bullet at all,
#     one is written right after the heading from `--ref`, backticked; with no
#     `--ref` either it is refused, naming the plan-wide line instead.
#   - The plan line is the first canonical `**Wait budget:**` line in
#     §Session budget (`_section 2 "session budget"`), behind an optional `> `
#     or `- `; its first duration is replaced, prefix and note kept. With no
#     such line it goes in as the section's first line; with no section, one is
#     added above `## Phases`, else at the end — never above `## Phase graph`.
#   - The duration written is the plainest spelling of the minutes asked:
#     whole days as `Nd`, whole hours as `Nh`, else `Nm`.
#   - The write is read back through the engine and compared with what was
#     asked; a disagreement is exit 1 and names the file. It cannot happen
#     while the rules above hold, which is the point: it is the alarm for the
#     day one side changes without the other.
set -euo pipefail
usage="usage: wait-budget.sh <slug> [--phase N [--ref REF]...] <max> | wait-budget.sh <slug> [--phase N] --count <n>"
slug="${1:?$usage}"
shift
phase=""; max=""; refs=(); count=""
while [ $# -gt 0 ]; do
  case "$1" in
    --phase) phase="${2:?--phase needs a number}"; shift 2 ;;
    --ref) refs+=("${2:?--ref needs a ref}"); shift 2 ;;
    --count) count="${2:?--count needs a number}"; shift 2 ;;
    -*) echo "unknown option: $1" >&2; echo "$usage" >&2; exit 2 ;;
    *)
      [ -z "$max" ] || { echo "one budget only, got: $max and $1" >&2; exit 2; }
      max="$1"; shift ;;
  esac
done
if [ -n "$count" ]; then
  [ -z "$max" ] || { echo "--count sets the number of waits, <max> the time they may take: one change per call, got both" >&2; exit 2; }
  [ "${#refs[@]}" -eq 0 ] || { echo "--ref names a phase's waits for its Waits on: bullet; --count does not take one" >&2; exit 2; }
  case "$count" in ''|*[!0-9]*) echo "--count needs a whole number from 1 to 99, got: $count" >&2; exit 2 ;; esac
  count=$((10#$count))
  [ "$count" -ge 1 ] && [ "$count" -le 99 ] || { echo "--count needs a whole number from 1 to 99, got: $count" >&2; exit 2; }
fi
[ -n "$max" ] || [ -n "$count" ] || { echo "$usage" >&2; exit 2; }
if [ -n "$phase" ]; then
  case "$phase" in ''|*[!0-9]*) echo "phase must be a number, got: $phase" >&2; exit 2 ;; esac
  phase=$((10#$phase))   # `08` is a handoff filename, not a number — normalise once
fi
[ "${#refs[@]}" -eq 0 ] || [ -n "$phase" ] || { echo "--ref names a phase's waits: it needs --phase N" >&2; exit 2; }

# The duration, as the reader parses one (duration_minutes): a number and a
# unit, or bare minutes. Anything else — `soon`, `0m`, `1.5h` — is refused
# rather than guessed at.
if [ -z "$count" ]; then
minutes="$(printf '%s' "$max" | awk '{
  s = tolower($0); gsub(/^[[:space:]]+|[[:space:]]+$/, "", s)
  if (s ~ /^[0-9]+$/) { n = s + 0; if (n > 0) print n; exit }
  if (!match(s, /^[0-9]+[[:space:]]*(minutes|minute|mins|min|m|hours|hour|hrs|hr|h|days|day|d)$/)) exit
  n = s; sub(/[^0-9].*$/, "", n); n = n + 0
  u = s; sub(/^[0-9]+[[:space:]]*/, "", u)
  if (n <= 0) exit
  if (u ~ /^d/) print n * 1440; else if (u ~ /^h/) print n * 60; else print n
}')"
[ -n "$minutes" ] || { echo "not a duration: $max (want e.g. 90m, 2h, 3d, or bare minutes)" >&2; exit 2; }
if [ $((minutes % 1440)) -eq 0 ]; then spelled="$((minutes / 1440))d"
elif [ $((minutes % 60)) -eq 0 ]; then spelled="$((minutes / 60))h"
else spelled="${minutes}m"; fi
fi

for r in ${refs[@]+"${refs[@]}"}; do
  case "$r" in
    *'`'*|*'·'*|*$'\n'*|'') echo "a ref cannot hold a backtick, a middle dot or a newline: $r" >&2; exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/instance.sh"
DOCS_ROOT="$(pe_docs_root)"; export DOCS_ROOT
f="$DOCS_ROOT/docs/plans/$slug.md"
[ -f "$f" ] || { echo "no such plan: $f" >&2; exit 2; }

# The rewrite lands only when it changed something: a no-op raise that still
# replaced the file would wake every watcher of docs/ for bytes that did not move.
commit() {  # commit <tmp>
  if cmp -s "$1" "$f"; then rm -f "$1"; else mv "$1" "$f"; fi
}
tmp="$f.tmp.$$"

# ---- the COUNT (control-tower phase 121, #40): one line, rewritten or added --
if [ -n "$count" ]; then
  if [ -z "$phase" ]; then
    LC_ALL=C awk -v n="$count" '
      tolower($0) ~ /^##[[:space:]]+session budget/ { insec=1; seen=1; print; next }
      /^##[[:space:]]/ { if (insec && !done) { print "> **Wait count:** " n; print ""; done=1 } insec=0 }
      insec && !done && tolower($0) ~ /^[[:space:]>]*([-*][[:space:]]+)?\*{0,2}wait[[:space:]]+count\*{0,2}[[:space:]]*:/ {
        p = index($0, ":"); head = substr($0, 1, p); rest = substr($0, p + 1)
        if (match(rest, /^\*+/)) { head = head substr(rest, 1, RLENGTH) }
        print head " " n; done=1; next
      }
      { print }
      END { if (!seen) { print ""; print "## Session budget"; print ""; print "> **Wait count:** " n } else if (insec && !done) print "> **Wait count:** " n }
    ' "$f" > "$tmp"
  else
    has="$(awk -v want="$phase" '
      /^###[[:space:]]+[Pp]hase[[:space:]]+[0-9]+/ {
        h=$0; sub(/^###[[:space:]]+[Pp]hase[[:space:]]+/,"",h); sub(/[^0-9].*/,"",h); if (h==want) found=1
      }
      END { print (found ? "yes" : "no") }
    ' "$f")"
    [ "$has" = yes ] || {
      echo "phase $phase: no \"### Phase $phase\" section in $f — the engine reads a phase's wait count from that block, so there is nowhere to write one" >&2
      exit 2
    }
    LC_ALL=C awk -v want="$phase" -v n="$count" '
      /^###[[:space:]]+[Pp]hase[[:space:]]+[0-9]+/ {
        h=$0; sub(/^###[[:space:]]+[Pp]hase[[:space:]]+/,"",h); sub(/[^0-9].*/,"",h)
        if (cur && !done) { pend=0 }
        cur=(h==want)?1:0
        if (cur) { print; pend=1; next }
      }
      /^##[[:space:]]/ && !/^###/ { cur=0 }
      cur && !done && tolower($0) ~ /^[[:space:]]*[-*][[:space:]]*\*{0,2}wait[[:space:]]+count\*{0,2}[[:space:]]*:/ {
        p = index($0, ":"); head = substr($0, 1, p); rest = substr($0, p + 1)
        if (match(rest, /^\*+/)) { head = head substr(rest, 1, RLENGTH) }
        print head " " n; done=1; next
      }
      { print }
    ' "$f" > "$tmp"
    if ! grep -qiE '^[[:space:]]*[-*][[:space:]]*\*{0,2}wait[[:space:]]+count\*{0,2}[[:space:]]*:[[:space:]]*\*{0,2}[[:space:]]*'"$count"'$' "$tmp" \
       || [ "$(awk -v want="$phase" '
            /^###[[:space:]]+[Pp]hase[[:space:]]+[0-9]+/ { h=$0; sub(/^###[[:space:]]+[Pp]hase[[:space:]]+/,"",h); sub(/[^0-9].*/,"",h); cur=(h==want)?1:0; next }
            /^##[[:space:]]/ { cur=0 }
            cur && tolower($0) ~ /wait[[:space:]]+count/ { c++ }
            END { print c+0 }' "$tmp")" -eq 0 ]; then
      # No bullet in the phase yet: one after the heading.
      LC_ALL=C awk -v want="$phase" -v line="- **Wait count:** $count" '
        /^###[[:space:]]+[Pp]hase[[:space:]]+[0-9]+/ && !done {
          h=$0; sub(/^###[[:space:]]+[Pp]hase[[:space:]]+/,"",h); sub(/[^0-9].*/,"",h)
          if (h==want) { print; print line; done=1; next }
        }
        { print }
      ' "$f" > "$tmp"
    fi
  fi
  commit "$tmp"
  if [ -n "$phase" ]; then
    answer="$("$SCRIPT_DIR/phase-graph.sh" "$slug" --wait-count "$phase")" \
      || { echo "wait-budget.sh: the edit is written, but phase-graph.sh could not read $f back (see above)" >&2; exit 1; }
    want="$(printf '%s\tphase' "$count")"
  else
    answer="$("$SCRIPT_DIR/phase-graph.sh" "$slug" --wait-count)" \
      || { echo "wait-budget.sh: the edit is written, but phase-graph.sh could not read $f back (see above)" >&2; exit 1; }
    want="$(printf '%s\tplan' "$count")"
  fi
  [ "$answer" = "$want" ] || {
    echo "wait-budget.sh: wrote the wait count $count${phase:+ for phase $phase}, but phase-graph.sh --wait-count${phase:+ $phase} reads \"$answer\" — $f carries a count this script did not write; edit it by hand" >&2
    exit 1
  }
  printf '%s\n' "$answer"
  exit 0
fi

# The shared half of both rewrites: in `rest`, replace the FIRST duration the
# reader would parse (and a `~` hugging it), keeping what follows; with none,
# the value becomes the duration alone. The rewrites run in the C locale, so the
# middle dot is two bytes to awk and `index` finds it the same way everywhere;
# the read-back below runs in the caller's, exactly as every other reader does.
AWK_SWAP='
  function swap(rest, spelled,   tok, pre, post) {
    if (!match(rest, /[0-9]+[[:space:]]*(minutes|minute|mins|min|m|hours|hour|hrs|hr|h|days|day|d)([^A-Za-z0-9_]|$)/)) {
      return " " spelled
    }
    tok = substr(rest, RSTART, RLENGTH)
    sub(/[^A-Za-z0-9_]$/, "", tok)
    pre = substr(rest, 1, RSTART - 1)
    post = substr(rest, RSTART + length(tok))
    sub(/~[[:space:]]*$/, "", pre)
    return pre spelled post
  }
'

if [ -z "$phase" ]; then
  # ---- plan-wide: the §Session budget line ----------------------------------
  state="$(awk '
    tolower($0) ~ /^##[[:space:]]+session budget/ { has=1; insec=1; next }
    /^##[[:space:]]/ { insec=0 }
    insec && tolower($0) ~ /^[[:space:]>]*([-*][[:space:]]+)?\*{0,2}wait[[:space:]]+budget\*{0,2}[[:space:]]*:/ { found=1 }
    END { print (has ? (found ? "present" : "absent") : "none") }
  ' "$f")"
  case "$state" in
    present)
      LC_ALL=C awk -v spelled="$spelled" "$AWK_SWAP"'
        tolower($0) ~ /^##[[:space:]]+session budget/ { insec=1; print; next }
        /^##[[:space:]]/ { insec=0 }
        insec && !done && tolower($0) ~ /^[[:space:]>]*([-*][[:space:]]+)?\*{0,2}wait[[:space:]]+budget\*{0,2}[[:space:]]*:/ {
          # The label runs to its colon and any bold that closes after it.
          p = index($0, ":")
          head = substr($0, 1, p); rest = substr($0, p + 1)
          if (match(rest, /^\*+/)) { head = head substr(rest, 1, RLENGTH); rest = substr(rest, RLENGTH + 1) }
          print head swap(rest, spelled); done=1; next
        }
        { print }
      ' "$f" > "$tmp" ;;
    absent)
      awk -v line="**Wait budget:** $spelled" '
        tolower($0) ~ /^##[[:space:]]+session budget/ && !done { print; pend=1; done=1; next }
        pend && /^[[:space:]]*$/ { print; next }
        pend { print line; if ($0 !~ /^[[:space:]]*$/) print ""; pend=0 }
        { print }
        END { if (pend) print line }
      ' "$f" > "$tmp" ;;
    none)
      awk -v line="**Wait budget:** $spelled" '
        BEGIN { prevblank=1 }
        !done && tolower($0) ~ /^##[[:space:]]+phases[[:space:]]*$/ {
          if (!prevblank) print ""
          print "## Session budget"; print ""; print line; print ""
          done=1
        }
        { print; prevblank = ($0 ~ /^[[:space:]]*$/) }
        END { if (!done) { if (!prevblank) print ""; print "## Session budget"; print ""; print line } }
      ' "$f" > "$tmp" ;;
  esac
  commit "$tmp"
else
  # ---- per phase: the ### Phase N bullet ------------------------------------
  state="$(awk -v want="$phase" '
    /^###[[:space:]]+[Pp]hase[[:space:]]+[0-9]+/ {
      h=$0; sub(/^###[[:space:]]+[Pp]hase[[:space:]]+/,"",h); sub(/[^0-9].*/,"",h)
      cur=(h==want)?1:0; if (cur) has=1
    }
    /^##[[:space:]]/ && cur { cur=0 }
    cur && tolower($0) ~ /^[[:space:]]*[-*][[:space:]]*\*{0,2}waits[[:space:]]+on\*{0,2}[[:space:]]*:/ { found=1 }
    END { print (has ? (found ? "present" : "absent") : "none") }
  ' "$f")"
  [ "$state" != none ] || {
    echo "phase $phase: no \"### Phase $phase\" section in $f — the engine reads a phase's wait budget from that block, so there is nowhere to write one" >&2
    exit 2
  }
  case "$state" in
    present)
      LC_ALL=C awk -v want="$phase" -v spelled="$spelled" "$AWK_SWAP"'
        /^###[[:space:]]+[Pp]hase[[:space:]]+[0-9]+/ {
          h=$0; sub(/^###[[:space:]]+[Pp]hase[[:space:]]+/,"",h); sub(/[^0-9].*/,"",h)
          cur=(h==want)?1:0
        }
        /^##[[:space:]]/ && cur { cur=0 }
        cur && !done && tolower($0) ~ /^[[:space:]]*[-*][[:space:]]*\*{0,2}waits[[:space:]]+on\*{0,2}[[:space:]]*:/ {
          dot = index($0, "\302\267")
          if (dot) {
            print substr($0, 1, dot + 1) swap(substr($0, dot + 2), spelled)
          } else {
            line = $0; sub(/[[:space:]]+$/, "", line)
            print line " \302\267 " spelled
          }
          done=1; next
        }
        { print }
      ' "$f" > "$tmp" ;;
    absent)
      [ "${#refs[@]}" -gt 0 ] || {
        echo "phase $phase has no \`- **Waits on:**\` bullet, and one names what the phase waits on (\`<ref>[, <ref>…] · <max>\`): pass --ref for each, or raise the plan's \`**Wait budget:**\` instead (no --phase)" >&2
        exit 2
      }
      named=""
      for r in "${refs[@]}"; do named="${named:+$named, }\`$r\`"; done
      LC_ALL=C awk -v want="$phase" -v line="- **Waits on:** $named · $spelled" '
        /^###[[:space:]]+[Pp]hase[[:space:]]+[0-9]+/ && !done {
          h=$0; sub(/^###[[:space:]]+[Pp]hase[[:space:]]+/,"",h); sub(/[^0-9].*/,"",h)
          if (h==want) { print; pend=1; done=1; next }
        }
        pend && /^[[:space:]]*$/ { print; next }
        pend { print line; if ($0 !~ /^[[:space:]]*[-*][[:space:]]/) print ""; pend=0 }
        { print }
        END { if (pend) print line }
      ' "$f" > "$tmp" ;;
  esac
  commit "$tmp"
fi

# ---- the read-back ------------------------------------------------------------
if [ -n "$phase" ]; then
  answer="$("$SCRIPT_DIR/phase-graph.sh" "$slug" --wait-budget "$phase")" \
    || { echo "wait-budget.sh: the edit is written, but phase-graph.sh could not read $f back (see above)" >&2; exit 1; }
  want="$(printf '%s\tphase' "$minutes")"
else
  answer="$("$SCRIPT_DIR/phase-graph.sh" "$slug" --wait-budget)" \
    || { echo "wait-budget.sh: the edit is written, but phase-graph.sh could not read $f back (see above)" >&2; exit 1; }
  want="$(printf '%s\tplan' "$minutes")"
fi
[ "$answer" = "$want" ] || {
  echo "wait-budget.sh: wrote the wait budget $spelled${phase:+ for phase $phase}, but phase-graph.sh --wait-budget${phase:+ $phase} reads \"$answer\" — $f carries a wait directive this script did not write; edit it by hand" >&2
  exit 1
}
printf '%s\n' "$answer"
exit 0
