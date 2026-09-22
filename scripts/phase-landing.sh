#!/usr/bin/env bash
# Record where a phase's work has actually got to — docs/handoffs/<slug>/landing.md.
#
# Usage:
#   phase-landing.sh <slug> <phase> <state> [--repo KEY] [--policy WORD] [--ref REF]
#                                           [--sha SHA] [--pr URL] [--by WHO] [--note TEXT]
#   phase-landing.sh <slug> list [phase]
#
#   state: held | integrated | pushed | pr-open | pr-merged | landed | conflict | failed
#          (scripts/landing.env — the bash twin of viewer/shared/landing-model.js)
#
# ## Why a file rather than a question
#
# "Is phase 8's work on the branch I build on?" is a fact three readers need —
# a session about to start phase 9, the console's Gate card, and the autopilot —
# and until now the only way to learn it was to ask GitHub. A gate that shells
# out gives DIFFERENT answers to different callers (a page view will not run a
# command; `PHASE_EXEC_GATES=1` will), which is how one gate came to tell a
# session and its supervisor opposite things at the same instant. So the landing
# session writes what it did, here, and `--gate-status` reads it and runs
# nothing. No network, no `gh`, no authentication, identical for everyone.
#
# ## A row is a POSITION, not a log
#
# The upsert key is (phase, repo) and a second record REPLACES the first: a
# phase that is `pushed`, then `pr-open`, then `pr-merged` has moved, it has not
# happened three times. The history of how it moved is the journal's job, where
# it is already recorded with a timestamp and an actor. Two rows for one phase
# would make "the state" ambiguous for every reader at once — the failure
# `qa-record.sh` already learned the hard way with its duplicate status rows.
#
# The key is (phase, REPO) and not (phase) because a mirror run lands N times:
# one superproject phase commits in three submodules and each moves on its own
# clock. A run on a plain repository writes an empty repo cell and has one row,
# which is the same rule stated for the case where N is 1.
#
# Deterministic and idempotent, like every writer under scripts/: it never
# touches git (the caller commits), never prompts, and refuses rather than
# guesses. bash 3.2.
set -euo pipefail

slug="${1:?usage: phase-landing.sh <slug> <phase> <state> [--repo KEY] [--policy WORD] [--ref REF] [--sha SHA] [--pr URL] [--by WHO] [--note TEXT]  |  phase-landing.sh <slug> list [phase]}"
verb="${2:?phase number or \`list\` required}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/instance.sh"
DOCS_ROOT="$(pe_docs_root)"

# The vocabulary, with the same in-file defaults every script here carries so a
# missing .env cannot silently narrow what the ledger will accept.
LANDING_STATES="held integrated pushed pr-open pr-merged landed conflict failed"
DEFAULT_LAND="hold"
# shellcheck source=/dev/null
[ -f "$SCRIPT_DIR/landing.env" ] && . "$SCRIPT_DIR/landing.env"

dir="$DOCS_ROOT/docs/handoffs/$slug"
f="$dir/landing.md"

# ---- list -------------------------------------------------------------------
if [ "$verb" = list ]; then
  want="${3:-}"
  [ -f "$f" ] || exit 0
  DOCS_ROOT="$DOCS_ROOT" "$SCRIPT_DIR/phase-graph.sh" "$slug" --landing "$want" 2>/dev/null && exit 0
  # With no phase argument the engine's arm wants one, so print every row here.
  awk 'BEGIN{ show=0 }
    tolower($0) ~ /^##[[:space:]]+landings/ { show=1; next }
    show && /^#/ { show=0 }
    show && /^\|/ { print }
  ' "$f"
  exit 0
fi

# ---- record -----------------------------------------------------------------
phase="$verb"
state="${3:?state required: $LANDING_STATES}"
shift 3

repo=""; policy=""; ref=""; sha=""; pr=""; by=""; note=""
while [ $# -gt 0 ]; do
  case "$1" in
    # An EMPTY key is a legal one — the root of a mirror, or a plain
    # repository — and it is exactly what the landing prompt writes as
    # `--repo ''`; the flag only needs a second argument to exist.
    --repo)   [ $# -ge 2 ] || { echo "--repo needs a repository key ('' for the root)" >&2; exit 2; }; repo="$2"; shift 2 ;;
    --policy) policy="${2:?--policy needs a word}"; shift 2 ;;
    --ref)    ref="${2:?--ref needs a git ref}"; shift 2 ;;
    --sha)    sha="${2:?--sha needs a sha}"; shift 2 ;;
    --pr)     pr="${2:?--pr needs a url or number}"; shift 2 ;;
    --by)     by="${2:?--by needs a name}"; shift 2 ;;
    --note)   note="${2:?--note needs text}"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

case "$phase" in ''|*[!0-9]*) echo "phase must be a number, got: $phase" >&2; exit 2 ;; esac
phase=$((10#$phase))   # `08` is a handoff filename, not a number — normalise once

case " $LANDING_STATES " in
  *" $state "*) ;;
  *) echo "unknown landing state: $state (want one of: $LANDING_STATES)" >&2; exit 2 ;;
esac

# Every cell, sanitised the way qa-record.sh sanitises its own: a pipe splits
# the row and a newline ends it, and every reader on both sides of this seam
# counts cells. Refused for the fields a person types by hand; ESCAPED for the
# one field that is free prose, because a note is a sentence about something
# that went wrong and refusing it would lose the sentence at the worst moment.
for pair in "repo:$repo" "policy:$policy" "ref:$ref" "sha:$sha" "pr:$pr" "by:$by"; do
  case "${pair#*:}" in
    *"|"*) echo "--${pair%%:*} may not contain a pipe: ${pair#*:}" >&2; exit 2 ;;
    *"
"*) echo "--${pair%%:*} may not contain a newline" >&2; exit 2 ;;
  esac
done
note="$(printf '%s' "$note" | tr '\n\t' '  ' | sed 's/|/\\|/g')"
[ "${#note}" -le 280 ] || { echo "--note is limited to 280 characters, got ${#note}" >&2; exit 2; }

# The phase must be in the plan, and the plan is the engine's to read. `--land`
# answers the membership question and the policy question at once, which is why
# it is the one asked: a ledger row whose Policy cell disagrees with the plan is
# a row that makes a `landed` gate unanswerable.
if ! land_answer="$(DOCS_ROOT="$DOCS_ROOT" "$SCRIPT_DIR/phase-graph.sh" "$slug" --land "$phase" 2>&1)"; then
  printf '%s\n' "$land_answer" >&2
  exit 2
fi
[ -n "$policy" ] || policy="$(printf '%s' "$land_answer" | cut -f1)"
[ -n "$policy" ] || policy="$DEFAULT_LAND"
[ -n "$by" ] || by="${PE_OWNER:-$(whoami)@$(hostname -s 2>/dev/null || echo local)}"
recorded="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

mkdir -p "$dir"
if [ ! -f "$f" ]; then
  {
    printf '# Landings — %s\n\n' "$slug"
    printf 'Where each phase'\''s work has actually got to. Written by scripts/phase-landing.sh —\n'
    printf 'never hand-edited. The engine reads the "State" column: a `landed N` gate clears\n'
    printf 'when the row reaches the state that phase'\''s landing policy ends at, and a\n'
    printf '`pr-merged N` gate only on `pr-merged`. One row per (phase, repository): a phase\n'
    printf 'that moves twice has moved, it has not happened twice.\n\n'
    printf '## Landings\n\n'
    printf '| Phase | Repo | State | Policy | Ref | SHA | PR | By | Recorded | Note |\n'
    printf '|------:|------|-------|--------|-----|-----|----|----|----------|------|\n'
  } > "$f"
fi

row="$(printf '| %s | %s | %s | %s | %s | %s | %s | %s | %s | %s |' \
  "$phase" "${repo:--}" "$state" "$policy" "${ref:--}" "${sha:--}" "${pr:--}" "$by" "$recorded" "${note:--}")"

# Upsert on (phase, repo), located by HEADER NAME on the read side and by the
# first two cells here — the writer owns the column order, so it may count.
tmp="$f.tmp.$$"
PE_ROW="$row" awk -F'|' -v ph="$phase" -v rp="${repo:--}" '
  function trim(s){ gsub(/[*`]/,"",s); sub(/^[ \t]+/,"",s); sub(/[ \t]+$/,"",s); return s }
  BEGIN{ replaced=0 }
  /^\|/ && trim($2) == ph && trim($3) == rp && trim($2) != "Phase" {
    if (!replaced) { print ENVIRON["PE_ROW"]; replaced=1 }
    next
  }
  { print }
  END{ if (!replaced) print ENVIRON["PE_ROW"] }
' "$f" > "$tmp"
mv "$tmp" "$f"

printf 'landing: %s phase %s%s → %s (policy %s)\n' \
  "$slug" "$phase" "${repo:+ [$repo]}" "$state" "$policy"
