#!/usr/bin/env bash
# Close a plan — or reopen one.
#
# Progress is computed and never stored: `phase-graph.sh` derives done/ready/waiting
# from the handoffs, and no amount of reading them can answer "does anyone still care
# about this plan?". That is an operator decision, so it is the one piece of plan state
# that IS stored — in the plan's own `status:` frontmatter.
#
# A terminal status (complete | abandoned | superseded) means the plan is CLOSED: it
# stops reporting stuck handoffs, QA failures, drift warnings, ready phases, boot
# prompts, batching and notifications. Its board still renders in full and genuine
# structural damage is still reported as a note — closing quiets a plan, it never
# hides or deletes one, and `--reopen` reverses it.
#
# `complete` is a claim about the work, so it is checked before it is written (#320,
# the regression of #184): it is refused — naming each item — while the plan's run
# branch `pe/<slug>` is not held by its repository's origin trunk (as this clone
# last fetched it), while `landing.md` has a row in `conflict` or `failed`, or while
# an issue labelled `plan:<slug>` is open on a repository of the docs root. `--force`
# closes it anyway, says so, and writes the exception into `closed_reason`.
# It is also refused — and `--force` does not help — while the plan's
# `## Not yet specified` section holds a line (measured-console phase 30).
#
# Usage:
#   close-plan.sh <slug> [--status abandoned|superseded|complete] [--reason "TEXT"] [--force]
#   close-plan.sh <slug> --reopen
#
# Closing also reads the plan's memory, `docs/memory/<slug>/index.md` (measured-console
# phase 4): a claim there — a list item — that carries neither a date (YYYY-MM-DD) nor
# a commit is NAMED, by line, so the memory a plan leaves behind is history rather
# than a present tense nobody can date. It names; it never refuses.
#
# Writes only the plan file (and releases that plan's own phase locks). It reads git
# and asks `gh` for the open issues; it never moves a ref, fetches or pushes.
set -euo pipefail

slug="${1:?usage: close-plan.sh <slug> [--status abandoned|superseded|complete] [--reason TEXT] [--reopen] [--force]}"
shift

status="abandoned"; reason=""; reopen=0; force=0
while [ $# -gt 0 ]; do
  case "$1" in
    --status) status="$(printf '%s' "${2:?--status needs a value}" | tr '[:upper:]' '[:lower:]')"; shift 2 ;;
    --reason) reason="${2:?--reason needs text}"; shift 2 ;;
    --reopen) reopen=1; shift ;;
    --force)  force=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

if [ "$reopen" = 1 ]; then
  case "$status:$reason" in
    abandoned:) : ;;
    *) echo "--reopen takes no --status or --reason" >&2; exit 2 ;;
  esac
else
  case "$status" in
    complete|abandoned|superseded) : ;;
    active) echo "active is not a closed status — use --reopen to reopen a plan" >&2; exit 2 ;;
    *) echo "invalid status: $status (want complete|abandoned|superseded)" >&2; exit 2 ;;
  esac
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/instance.sh"
DOCS_ROOT="$(pe_docs_root)"
plan_file="$DOCS_ROOT/docs/plans/${slug}.md"
[ -f "$plan_file" ] || { echo "no such plan: $plan_file" >&2; exit 2; }
head -1 "$plan_file" | grep -q '^---[[:space:]]*$' \
  || { echo "plan has no frontmatter block: $plan_file" >&2; exit 2; }

# One line, no comment marker (every reader strips `# ...` as a legend), no runaway
# length — a reason is a sentence, not a changelog.
reason="$(printf '%s' "$reason" | tr '\n\r\t' '   ' | tr -d '#' | sed 's/  */ /g; s/^ //; s/ $//' | cut -c1-200)"
if [ "$reopen" = 0 ] && [ -z "$reason" ] && [ "$force" = 0 ]; then
  echo "refusing to close $slug without --reason (or pass --force)" >&2
  exit 2
fi

# ---- `complete` is checked: the work landed, nothing of the plan's left open ----
# One line per item still in the way, on stdout; nothing when there is none.
blockers_of_complete() {
  local repo dir trunk ref held tree want nwo line
  # The repositories of the docs root: the root itself and every submodule
  # checkout. A repository that never carried the plan's branch says nothing.
  {
    printf '%s\t%s\n' "-" "$DOCS_ROOT"
    if [ -f "$DOCS_ROOT/.gitmodules" ]; then
      { git config -f "$DOCS_ROOT/.gitmodules" --get-regexp '\.path$' 2>/dev/null || true; } \
        | while read -r _ path; do printf '%s\t%s\n' "$path" "$DOCS_ROOT/$path"; done
    fi
  } | while IFS="$(printf '\t')" read -r repo dir; do
    git -C "$dir" rev-parse --git-dir >/dev/null 2>&1 || continue
    [ "$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null)" = "$(cd "$dir" && pwd -P)" ] || continue
    [ "$repo" = "-" ] && repo="the root"
    ref=""
    for want in "refs/remotes/origin/pe/$slug" "refs/heads/pe/$slug"; do
      git -C "$dir" rev-parse -q --verify "$want^{commit}" >/dev/null 2>&1 && { ref="$want"; break; }
    done
    if [ -n "$ref" ]; then
      trunk="$(git -C "$dir" symbolic-ref -q refs/remotes/origin/HEAD 2>/dev/null || true)"
      for want in "$trunk" refs/remotes/origin/main refs/remotes/origin/master; do
        [ -n "$want" ] && git -C "$dir" rev-parse -q --verify "$want^{commit}" >/dev/null 2>&1 && { trunk="$want"; break; }
        trunk=""
      done
      if [ -z "$trunk" ]; then
        git -C "$dir" remote get-url origin >/dev/null 2>&1 \
          && printf '  unlanded: pe/%s in %s — origin has no trunk here to hold it (git fetch first)\n' "$slug" "$repo"
      else
        held=0
        git -C "$dir" merge-base --is-ancestor "$ref" "$trunk" 2>/dev/null && held=1
        if [ "$held" = 0 ]; then
          # A squash or rebase merge leaves the branch's commits off the trunk
          # while its CONTENT is there: merging it in would change nothing.
          tree="$(git -C "$dir" merge-tree --write-tree "$trunk" "$ref" 2>/dev/null | head -1 || true)"
          [ -n "$tree" ] && [ "$tree" = "$(git -C "$dir" rev-parse "$trunk^{tree}" 2>/dev/null)" ] && held=1
        fi
        [ "$held" = 1 ] || printf '  unlanded: pe/%s in %s is not on %s (as this clone last fetched it)\n' \
          "$slug" "$repo" "${trunk#refs/remotes/}"
      fi
    fi
    # The repository's GitHub name, for the open issues below.
    nwo="$(git -C "$dir" remote get-url origin 2>/dev/null | sed -n \
      -e 's#^https://github\.com/\([^/]*/[^/]*\)$#\1#p' \
      -e 's#^ssh://git@github\.com/\([^/]*/[^/]*\)$#\1#p' \
      -e 's#^git@github\.com:\([^/]*/[^/]*\)$#\1#p' | head -1 | sed 's#\.git$##')"
    [ -n "$nwo" ] && printf '%s\n' "$nwo" >> "$repos_file"
  done
  # A landing that broke is never a close.
  if [ -f "$DOCS_ROOT/docs/handoffs/$slug/landing.md" ]; then
    awk -F'|' '
      tolower($0) ~ /^##[[:space:]]+landings/ { on = 1; next }
      on && /^#/ { on = 0 }
      on && /^\|/ {
        phase = $2; repo = $3; state = $4
        gsub(/^[ \t]+|[ \t]+$/, "", phase); gsub(/^[ \t]+|[ \t]+$/, "", repo); gsub(/^[ \t]+|[ \t]+$/, "", state)
        if (state == "conflict" || state == "failed") {
          printf "  landing: phase %s in %s is %s (docs/handoffs/%s/landing.md)\n", phase, (repo == "-" || repo == "" ? "the root" : repo), state, slug
        }
      }
    ' slug="$slug" "$DOCS_ROOT/docs/handoffs/$slug/landing.md"
  fi
  # The plan's own issues, still open where they live.
  [ -s "$repos_file" ] || return 0
  sort -u "$repos_file" | while IFS= read -r nwo; do
    [ -n "$nwo" ] || continue
    if ! command -v gh >/dev/null 2>&1; then
      printf '  issues: could not read the open plan:%s issues of %s — gh is not installed\n' "$slug" "$nwo"
      continue
    fi
    if ! line="$(gh issue list -R "$nwo" --label "plan:$slug" --state open --limit 200 \
        --json number,title --jq '.[] | "#\(.number) \(.title)"' 2>&1)"; then
      printf '  issues: could not read the open plan:%s issues of %s — %s\n' "$slug" "$nwo" "$(printf '%s' "$line" | head -1 | cut -c1-120)"
      continue
    fi
    printf '%s\n' "$line" | while IFS= read -r one; do
      [ -n "$one" ] && printf '  open: %s %s\n' "$nwo" "$(printf '%s' "$one" | cut -c1-120)"
    done
  done
  return 0
}

forced=""
# A plan that still lists what it has not specified is not complete — and unlike
# the items below, no --force closes it over that: the section is the plan's own
# word that work is missing (measured-console phase 30). Empty it (or say the
# line is done by removing it) and close again.
if [ "$reopen" = 0 ] && [ "$status" = complete ]; then
  nys="$(DOCS_ROOT="$DOCS_ROOT" bash "$SCRIPT_DIR/phase-graph.sh" "$slug" --not-yet-specified 2>/dev/null || true)"
  if [ -n "$nys" ]; then
    {
      echo "refusing to close $slug complete — its \"## Not yet specified\" section still holds $(printf '%s\n' "$nys" | grep -c .) line(s):"
      printf '%s\n' "$nys" | sed 's/^/  /'
      echo "specify each (or remove the line) first; --force does not close over this section"
    } >&2
    exit 1
  fi
fi
if [ "$reopen" = 0 ] && [ "$status" = complete ]; then
  repos_file="$(mktemp "${TMPDIR:-/tmp}/close-plan.XXXXXX")"
  trap 'rm -f "$repos_file"' EXIT
  blockers="$(blockers_of_complete)"
  if [ -n "$blockers" ]; then
    count="$(printf '%s\n' "$blockers" | grep -c .)"
    if [ "$force" = 0 ]; then
      {
        echo "refusing to close $slug complete — $count item(s) of its work are not done:"
        printf '%s\n' "$blockers"
        echo "land the branches and close or move the issues first; --force closes it complete anyway and records the exception"
      } >&2
      exit 1
    fi
    forced="$blockers"
    note="closed complete with $count item(s) open (--force)"
    reason="$(printf '%s' "${reason:+$reason — }$note" | cut -c1-200)"
  fi
fi

# PE_TODAY keeps the tests off the wall clock.
day="${PE_TODAY:-$(date +%Y-%m-%d)}"

tmp="$plan_file.tmp.$$"
awk -v st="$status" -v day="$day" -v reason="$reason" -v reopen="$reopen" '
  BEGIN { infm = 0; seen = 0 }
  NR == 1 && /^---[[:space:]]*$/ { print; infm = 1; next }
  infm && /^---[[:space:]]*$/ {
    if (!seen) print (reopen ? "status: active" : "status: " st)
    if (!reopen) {
      printf "closed: %s\n", day
      if (reason != "") printf "closed_reason: %s\n", reason
    }
    print; infm = 0; next
  }
  infm && /^status:/ { print (reopen ? "status: active" : "status: " st); seen = 1; next }
  infm && /^closed:/ { next }
  infm && /^closed_reason:/ { next }
  { print }
' "$plan_file" > "$tmp" && mv "$tmp" "$plan_file"

# A closed plan must never gate live work: `phase-lock.sh conflicts` scans every plan,
# so a dead plan's leftover lock would keep colliding with sessions on other plans.
#
# But only a lock that is actually a LEFTOVER. The sweep was unconditional, and
# a lease that has not passed is not debris: it is a session editing a working
# tree at this moment. Closing a plan is the operator's statement that nobody
# cares about it any more — never a licence to unlock somebody else's checkout,
# which is precisely what it bought: another plan admitted into that tree under
# a live hand session. A live lease is therefore KEPT and named, and `--force`
# is how an operator who knows the session is gone says so.
released=0
kept=""
lock_dir="$DOCS_ROOT/docs/handoffs/$slug/.locks"
if [ "$reopen" = 0 ] && [ -d "$lock_dir" ]; then
  lock_now="$(date +%s)"
  for lock in "$lock_dir"/phase-*.lock; do
    [ -e "$lock" ] || continue
    lease_until="$(grep -m1 '^lease_until=' "$lock" | sed 's/^lease_until=//' || true)"
    lock_owner="$(grep -m1 '^owner=' "$lock" | sed 's/^owner=//' || true)"
    lock_phase="$(grep -m1 '^phase=' "$lock" | sed 's/^phase=//' || true)"
    if [ "$force" = 0 ] && [ -n "$lease_until" ] && [ "$lock_now" -lt "$lease_until" ]; then
      until_h="$(date -r "$lease_until" '+%Y-%m-%d %H:%M' 2>/dev/null || printf '%s' "$lease_until")"
      kept="$kept  kept phase ${lock_phase:-?} — held by ${lock_owner:-?} until $until_h (live lease; --force releases it)
"
      continue
    fi
    rm -f "$lock"
    released=$((released + 1))
  done
  # Refuses a non-empty directory, which is exactly the guard wanted: a kept
  # lock keeps its folder.
  rmdir "$lock_dir" 2>/dev/null || true
fi

# The memory's undated claims: one line each — `index.md:<line>` and the claim's
# head. An item runs from its marker to the next item, heading or blank line, so a
# date on a continuation line counts.
memory_undated() {  # memory_undated <index.md>
  LC_ALL=C awk '
    function flush() {
      if (item != "" && item !~ /(^|[^0-9])20[0-9][0-9]-[01][0-9]-[0-3][0-9]([^0-9]|$)/) {
        head = item; if (length(head) > 100) head = substr(head, 1, 100) "…"
        printf "%d\t%s\n", at, head
      }
      item = ""
    }
    /^[[:space:]]*$/ || /^#/ { flush(); next }
    /^[[:space:]]*([-*+]|[0-9]+[.)])[[:space:]]/ { flush(); item = $0; at = NR; sub(/^[[:space:]]*([-*+]|[0-9]+[.)])[[:space:]]+/, "", item); next }
    item != "" { line = $0; sub(/^[[:space:]]+/, "", line); item = item " " line }
    END { flush() }
  ' "$1" | LC_ALL=C awk -F'\t' '
    { n = $2; sha = 0
      # a commit is 7 to 40 hex characters with a digit among them
      while (match(n, /[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]+/)) {
        w = substr(n, RSTART, RLENGTH); pre = (RSTART > 1 ? substr(n, RSTART - 1, 1) : " "); post = substr(n, RSTART + RLENGTH, 1)
        if (w ~ /[0-9]/ && RLENGTH <= 40 && pre !~ /[0-9A-Za-z]/ && post !~ /[0-9A-Za-z]/) { sha = 1; break }
        n = substr(n, RSTART + RLENGTH)
      }
      if (!sha) print
    }'
}
memory_lines=""
memory_index="$DOCS_ROOT/docs/memory/$slug/index.md"
if [ "$reopen" = 0 ] && [ -f "$memory_index" ]; then
  memory_lines="$(memory_undated "$memory_index" || true)"
fi

if [ "$reopen" = 1 ]; then
  echo "reopened: $slug is active again  ->  $plan_file"
else
  echo "closed: $slug = $status ($day)  ->  $plan_file"
  [ -n "$reason" ] && echo "  reason: $reason"
  [ "$released" -gt 0 ] && echo "  released $released phase lock(s) held by this plan"
  [ -n "$kept" ] && printf '%s' "$kept"
  if [ -n "$forced" ]; then
    echo "  --force: closed complete over what is still open:"
    printf '%s\n' "$forced"
  fi
  if [ -n "$memory_lines" ]; then
    printf '  memory: %s claim(s) in docs/memory/%s/index.md carry no date and no commit — write each as history (a date and the commit):\n' \
      "$(printf '%s\n' "$memory_lines" | grep -c .)" "$slug"
    printf '%s\n' "$memory_lines" | while IFS="$(printf '\t')" read -r at text; do
      printf '    index.md:%s  %s\n' "$at" "$text"
    done
  fi
fi
exit 0
