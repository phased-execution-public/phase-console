#!/usr/bin/env bash
# Amend a plan with one new phase — the ONE writer of a plan amendment.
#
# A plan is "rarely edited after design", but work turns up: a deferred item a
# run set aside (`--from`), a gap a phase found. This script is how the plan
# takes it in, so every amendment has the same shape and the console reads it
# the same way:
#
#   1. a `### Phase N — <title>` section, numbered LAST (N = highest + 1), at
#      the end of the `## Phases` region, with the plan-format bullets (Goal,
#      Size, Depends on, Exit criteria and Verification placeholders, and
#      `- **Amendment:** K (YYYY-MM-DD)[ · from <id>]`); a gated one carries
#      `*(GATED)*` and ALWAYS its `- **Gate-check:** <directive>`;
#   2. its `## Phase graph` row;
#   3. the dated note under the plan's title,
#      `> *(Amendment K, YYYY-MM-DD)* Phase N — <title>: <why>`;
#   4. the frontmatter `phases:` count, if the plan has a number there.
#
# The order is the fix for #416: the console once read a GATED graph row before
# its section existed and got an `ai` gate with an empty detail. Each step is
# its own atomic write (a temp file in the plan's directory, then a rename), so
# a reader between two steps never sees a graph row whose section is missing.
# (The engine also fails closed on that state now: `phase-graph.sh --gate-kind`
# reads `human` for it.) The result is linted; if the lint reports a problem the
# original plan did not have, the original file is put back and the script exits 1.
#
# Usage:
#   amend-plan.sh <slug> --title "TEXT" --size S|M|L --repos <csv> --depends <csv|->
#                 [--from <deferred-row-id>] [--gate "<type> <value>"] [--goal "TEXT"]
#                 [--date YYYY-MM-DD]
#
# stdout: the new phase number. Exit 0 written · 1 the lint refused it (plan
# restored) · 2 bad arguments or an unamendable plan (nothing written).
set -euo pipefail

usage() {
  echo "usage: amend-plan.sh <slug> --title TEXT --size S|M|L --repos <csv> --depends <csv|-> [--from ID] [--gate \"<type> <value>\"] [--goal TEXT] [--date YYYY-MM-DD]" >&2
}
die() { echo "amend-plan: $*" >&2; exit 2; }

[ $# -ge 1 ] || { usage; exit 2; }
case "$1" in -h|--help) usage; exit 0 ;; esac
slug="$1"; shift
case "$slug" in ''|-*|*/*) usage; exit 2 ;; esac

title=""; size=""; repos=""; depends=""; from=""; gate=""; goal=""; day=""
have_depends=0
while [ $# -gt 0 ]; do
  case "$1" in
    --title)   title="${2-}";   [ $# -ge 2 ] || die "--title needs a value"; shift 2 ;;
    --size)    size="${2-}";    [ $# -ge 2 ] || die "--size needs a value"; shift 2 ;;
    --repos)   repos="${2-}";   [ $# -ge 2 ] || die "--repos needs a value"; shift 2 ;;
    --depends) depends="${2-}"; [ $# -ge 2 ] || die "--depends needs a value"; have_depends=1; shift 2 ;;
    --from)    from="${2-}";    [ $# -ge 2 ] || die "--from needs a value"; shift 2 ;;
    --gate)    gate="${2-}";    [ $# -ge 2 ] || die "--gate needs a value"; shift 2 ;;
    --goal)    goal="${2-}";    [ $# -ge 2 ] || die "--goal needs a value"; shift 2 ;;
    --date)    day="${2-}";     [ $# -ge 2 ] || die "--date needs a value"; shift 2 ;;
    *) usage; die "unknown option: $1" ;;
  esac
done

one_line() { printf '%s' "$1" | tr '\n\r\t' '   ' | sed 's/  */ /g; s/^ //; s/ $//'; }
title="$(one_line "$title")"; goal="$(one_line "$goal")"; gate="$(one_line "$gate")"
[ -n "$title" ] || die "--title is required"
case "$title" in *'|'*) die "--title may not contain a pipe (it is a table cell)" ;; esac
case "$title" in *GATED*) die "--title may not contain GATED (use --gate)" ;; esac
case "$size" in S|M|L) ;; *) die "--size must be S, M or L" ;; esac
[ -n "$repos" ] || die "--repos is required (a csv of scope tokens, or all)"
case "$repos" in *'|'*) die "--repos may not contain a pipe" ;; esac
[ "$have_depends" = 1 ] && [ -n "$depends" ] || die "--depends is required (a csv of phase numbers, or - for none)"
case "$from" in *[!A-Za-z0-9._:/#-]*) die "--from must be a deferred row id (letters, digits, . _ : / # -)" ;; esac
[ -n "$day" ] || day="${PE_TODAY:-$(date +%Y-%m-%d)}"
case "$day" in [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;; *) die "--date must be YYYY-MM-DD" ;; esac

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/instance.sh"
DOCS_ROOT="$(pe_docs_root)"
plan_file="$DOCS_ROOT/docs/plans/${slug}.md"
[ -f "$plan_file" ] || die "no such plan: $plan_file"
head -1 "$plan_file" | grep -q '^---[[:space:]]*$' || die "plan has no frontmatter block: $plan_file"

# A closed plan is history: reopen it first.
if DOCS_ROOT="$DOCS_ROOT" bash "$SCRIPT_DIR/phase-graph.sh" "$slug" --closed >/dev/null 2>&1; then
  die "$slug is closed — reopen it (close-plan.sh $slug --reopen) before amending"
fi

# The gate vocabulary is gates.env's, the one the engine reads.
GATE_TYPES="phase phases plan cmd date deadline by manual ai landed pr-merged"
# shellcheck source=/dev/null
[ -f "$SCRIPT_DIR/gates.env" ] && . "$SCRIPT_DIR/gates.env"
if [ -n "$gate" ]; then
  gtype="${gate%% *}"
  case " $GATE_TYPES " in
    *" $gtype "*) ;;
    *) die "--gate type \"$gtype\" is not one of: $GATE_TYPES" ;;
  esac
fi

# ---- read the plan: the phases it has, its title, its amendments ------------
# The phases = the graph table's first column plus every `### Phase N` heading.
existing="$(awk '
  /^[ \t]*(```|~~~)/ { fence = !fence }
  fence { next }
  tolower($0) ~ /^##[ \t]+phase graph/ { g = 1; next }
  /^##[ \t]/ { g = 0 }
  g && /^[ \t]*\|/ { c = $0; sub(/^[ \t]*\|/, "", c); sub(/\|.*$/, "", c); gsub(/[*` \t]/, "", c); if (c ~ /^[0-9]+$/) print c + 0 }
  /^###[ \t]+[Pp]hase[ \t]+[0-9]+/ { h = $0; sub(/^###[ \t]+[Pp]hase[ \t]+/, "", h); sub(/[^0-9].*$/, "", h); print h + 0 }
' "$plan_file" | sort -n -u)"
maxp=0
for n in $existing; do [ "$n" -gt "$maxp" ] && maxp="$n"; done
[ "$maxp" -gt 0 ] || die "$plan_file has no phases to amend"
newp=$((maxp + 1))

grep -q '^# ' "$plan_file" || die "plan has no '# ' title line to carry the amendment note"
awk '
  /^[ \t]*(```|~~~)/ { fence = !fence }
  !fence && tolower($0) ~ /^##[ \t]+phases[ \t]*$/ { f = 1 }
  END { exit !f }' "$plan_file" || die "plan has no '## Phases' section"
awk '
  /^[ \t]*(```|~~~)/ { fence = !fence }
  !fence && tolower($0) ~ /^##[ \t]+phase graph/ { f = 1 }
  END { exit !f }' "$plan_file" || die "plan has no '## Phase graph' table"

# --depends: every named phase must exist; "-" (or an em dash) is none.
depends_cell="—"; depends_words=""
case "$depends" in
  -|—|–) ;;
  *)
    list=""
    for d in $(printf '%s' "$depends" | tr ',' ' '); do
      case "$d" in ''|*[!0-9]*) die "--depends names \"$d\", which is not a phase number (use a csv of numbers, or -)" ;; esac
      d=$((10#$d))
      printf '%s\n' "$existing" | grep -qx "$d" || die "--depends names phase $d, which this plan does not have (it has: $(printf '%s' "$existing" | tr '\n' ' ' | sed 's/ $//'))"
      case " $list " in *" $d "*) ;; *) list="$list $d" ;; esac
    done
    list="${list# }"
    depends_cell="$(printf '%s' "$list" | sed 's/ /, /g')"
    depends_words="$depends_cell"
    ;;
esac

repos_cell="$(printf '%s' "$repos" | tr ',' ' ' | sed 's/  */ /g; s/^ //; s/ $//; s/ /, /g')"
[ -n "$repos_cell" ] || die "--repos names nothing"

# Amendment number: the amendment notes there already are (the legacy "First
# amendment" shape counts too) or the highest number any carries, plus one.
k="$(awk '
  NR == 1 && /^---[ \t]*$/ { fm = 1; next }
  fm { if (/^---[ \t]*$/) fm = 0; next }
  /^##[ \t]/ { exit }
  /^>.*\*\([^)]*[Aa]mendment/ {
    n++
    if (match($0, /\*\(Amendment [0-9]+/)) { v = substr($0, RSTART + 12, RLENGTH - 12) + 0; if (v > hi) hi = v }
  }
  END { print (n > hi ? n : hi) + 1 }
' "$plan_file")"

# ---- the text to write ------------------------------------------------------
heading="### Phase $newp — $title"
[ -n "$gate" ] && heading="$heading *(GATED)*"
section_file="$(mktemp "${TMPDIR:-/tmp}/amend-plan-section.XXXXXX")"
orig_copy="$(mktemp "${TMPDIR:-/tmp}/amend-plan-orig.XXXXXX")"
lint_before="$(mktemp "${TMPDIR:-/tmp}/amend-plan-lint0.XXXXXX")"
lint_after="$(mktemp "${TMPDIR:-/tmp}/amend-plan-lint1.XXXXXX")"
tmp="$plan_file.tmp.$$"
trap 'rm -f "$section_file" "$orig_copy" "$lint_before" "$lint_after" "$tmp"' EXIT
cp "$plan_file" "$orig_copy"

{
  printf '%s\n' "$heading"
  printf -- '- **Goal:** %s\n' "${goal:-$title}"
  printf -- '- **Size:** %s\n' "$size"
  if [ -n "$depends_words" ]; then
    printf -- '- **Depends on:** %s\n' "$depends_words"
  else
    printf -- '- **Depends on:** none\n'
  fi
  [ -n "$gate" ] && printf -- '- **Gate-check:** %s\n' "$gate"
  printf -- '- **Exit criteria:** 1. TODO — name specific, independently verifiable outcomes before this phase boards.\n'
  printf -- '- **Verification:**\n  - `true`\n'
  if [ -n "$from" ]; then
    printf -- '- **Amendment:** %s (%s) · from %s\n' "$k" "$day" "$from"
  else
    printf -- '- **Amendment:** %s (%s)\n' "$k" "$day"
  fi
} > "$section_file"

note="> *(Amendment $k, $day)* Phase $newp — $title: ${goal:-$title}"
[ -n "$from" ] && note="$note (from deferred $from)"

# Replace the plan with $tmp, atomically.
commit_tmp() { mv "$tmp" "$plan_file"; }

# The lint's problems, one per line: the stderr lines that are not advisories
# (those open with "F<n> ") and not the verdict line. F49 is an advisory, but an
# amendment that makes it fire is an amendment that is wrong, so it counts here.
lint_problems() {  # lint_problems <out-file>
  DOCS_ROOT="$DOCS_ROOT" bash "$SCRIPT_DIR/phase-graph.sh" "$slug" --lint 2>&1 >/dev/null \
    | awk '/^LINT FAIL/ { next } /^F[0-9]+ / && !/^F49 / { next } { print }' > "$1" || true
}
lint_problems "$lint_before"

# ---- a. the section, at the end of the Phases region -------------------------
awk -v sec="$section_file" '
  { L[NR] = $0 }
  END {
    n = NR; p = 0; e = 0; fence = 0
    for (i = 1; i <= n; i++) {
      if (L[i] ~ /^[ \t]*(```|~~~)/) fence = !fence
      if (fence) continue
      if (!p && tolower(L[i]) ~ /^##[ \t]+phases[ \t]*$/) { p = i; continue }
      if (p && L[i] ~ /^##[ \t]/) { e = i; break }
    }
    last = (e ? e - 1 : n)
    while (last > p && L[last] ~ /^[ \t]*$/) last--
    for (i = 1; i <= last; i++) print L[i]
    print ""
    while ((getline line < sec) > 0) print line
    if (e) { print ""; for (i = e; i <= n; i++) print L[i] }
  }' "$plan_file" > "$tmp"
commit_tmp

# ---- b. its Phase graph row ---------------------------------------------------
cell_title="$title"
[ -n "$gate" ] && cell_title="$title *(GATED)*"
awk -v ph="$newp" -v ttl="$cell_title" -v dep="$depends_cell" -v rep="$repos_cell" '
  function trimc(x) { sub(/^[ \t]+/, "", x); sub(/[ \t]+$/, "", x); return x }
  { L[NR] = $0 }
  END {
    n = NR; g = 0; fence = 0; hdr = 0; lastrow = 0
    for (i = 1; i <= n; i++) {
      if (L[i] ~ /^[ \t]*(```|~~~)/) fence = !fence
      if (fence) continue
      if (!g && tolower(L[i]) ~ /^##[ \t]+phase graph/) { g = i; continue }
      if (g && L[i] ~ /^##[ \t]/) break
      if (g && L[i] ~ /^[ \t]*\|/) {
        c = L[i]; sub(/^[ \t]*\|/, "", c); sub(/\|.*$/, "", c); gsub(/[*` \t]/, "", c)
        if (!hdr && c !~ /^[0-9]+$/) hdr = i
        lastrow = i
      } else if (g && lastrow && L[i] !~ /^[ \t]*\|/) break
    }
    # Column order from the header (cells split on the pipes).
    row = "|"
    if (hdr) {
      h = L[hdr]; sub(/^[ \t]*\|/, "", h)
      m = split(h, H, "|")
      if (trimc(H[m]) == "") m--
      for (j = 1; j <= m; j++) {
        name = tolower(trimc(H[j])); v = "—"
        if (j == 1)                    v = ph
        else if (name ~ /^title/)      v = ttl
        else if (name ~ /depends/)     v = dep
        else if (name ~ /^repos/)      v = rep
        else if (name ~ /exit/)        v = "TODO — written when the phase is specified"
        else if (j == 2)               v = ttl
        row = row " " v " |"
      }
    } else {
      row = "| " ph " | " ttl " | " dep " | — | " rep " | TODO — written when the phase is specified |"
    }
    for (i = 1; i <= n; i++) { print L[i]; if (i == lastrow) print row }
  }' "$plan_file" > "$tmp"
commit_tmp

# ---- c. the dated note under the title ----------------------------------------
awk -v note="$note" '
  { L[NR] = $0 }
  END {
    n = NR; fm = 0; h1 = 0; lastq = 0; fence = 0
    for (i = 1; i <= n; i++) {
      if (i == 1 && L[i] ~ /^---[ \t]*$/) { fm = 1; continue }
      if (fm) { if (L[i] ~ /^---[ \t]*$/) fm = 0; continue }
      if (L[i] ~ /^[ \t]*(```|~~~)/) fence = !fence
      if (fence) continue
      if (!h1) { if (L[i] ~ /^# /) h1 = i; continue }
      if (L[i] ~ /^##[ \t]/) break
      if (L[i] ~ /^>/) lastq = i
    }
    at = (lastq ? lastq : h1)
    for (i = 1; i <= n; i++) {
      print L[i]
      if (i == at) {
        if (lastq) { print ">"; print note }
        else { print ""; print note; if (i < n && L[i + 1] !~ /^[ \t]*$/) print "" }
      }
    }
  }' "$plan_file" > "$tmp"
commit_tmp

# ---- d. the frontmatter count -------------------------------------------------
declared="$(grep -m1 '^phases:' "$plan_file" | sed 's/^phases:[[:space:]]*//; s/[[:space:]]*#.*$//' || true)"
case "$declared" in
  ''|*[!0-9]*) : ;;                       # absent, TODO or prose: not a number to bump
  *)
    rows="$(awk '
      /^[ \t]*(```|~~~)/ { fence = !fence }
      fence { next }
      tolower($0) ~ /^##[ \t]+phase graph/ { g = 1; next }
      /^##[ \t]/ { g = 0 }
      g && /^[ \t]*\|/ { c = $0; sub(/^[ \t]*\|/, "", c); sub(/\|.*$/, "", c); gsub(/[*` \t]/, "", c); if (c ~ /^[0-9]+$/) n++ }
      END { print n + 0 }' "$plan_file")"
    awk -v n="$rows" '
      NR == 1 && /^---[ \t]*$/ { fm = 1; print; next }
      fm && /^---[ \t]*$/ { fm = 0 }
      fm && !done && /^phases:/ {
        rest = $0; sub(/^phases:[ \t]*[0-9]+/, "", rest)
        print "phases: " n rest; done = 1; next
      }
      { print }' "$plan_file" > "$tmp"
    commit_tmp
    ;;
esac

# ---- the lint: nothing the original did not already have ----------------------
lint_problems "$lint_after"
new_problems="$(grep -vxF -f "$lint_before" "$lint_after" 2>/dev/null || true)"
# grep -f with an empty pattern file matches nothing, so an empty "before" keeps every line.
[ -s "$lint_before" ] || new_problems="$(cat "$lint_after")"
if [ -n "$new_problems" ]; then
  cp "$orig_copy" "$tmp" && commit_tmp
  {
    echo "amend-plan: the lint refused the amendment; $slug is unchanged. New problem(s):"
    printf '%s\n' "$new_problems" | sed 's/^/  /'
  } >&2
  exit 1
fi

printf '%s\n' "$newp"
