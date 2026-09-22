#!/usr/bin/env bash
# Scaffold docs/plans/<slug>.md from the skill template.
# Usage: new-plan.sh <slug>     (run from the repo root that owns docs/, or set DOCS_ROOT)
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
slug="${1:?usage: new-plan.sh <slug>}"

# 🔴 A slug ending `-p<digits>` is a LANE branch's name (SWP-1). The console
# mints `pe/<slug>` for a run and `pe/<slug>-p<N>` for phase N's lane, so a plan
# slugged `thing-p4` owns `pe/thing-p4` — which `runBranches('thing')` reads as
# plan `thing`'s phase-4 lane, and that list feeds a branch DELETE. Nothing can
# tell the two apart afterwards: they are the same string. Refused at birth,
# which is the only moment the name is still free.
case "$slug" in
  *-p*)
    # Everything after the LAST `-p`. All digits ⇒ the collision; anything else
    # (`thing-p`, `thing-p4-more`, `simple-plan`) is an ordinary name.
    case "${slug##*-p}" in
      ''|*[!0-9]*) : ;;
      *)
        printf 'refusing the slug %s: a name ending -p<number> collides with the lane branch pe/<slug>-p<N>,\n' "$slug" >&2
        printf '  which the console deletes once it has landed. Pick another name (e.g. %s-phase).\n' "${slug%-p*}" >&2
        exit 2 ;;
    esac ;;
esac

# shellcheck source=/dev/null
. "$SKILL_DIR/scripts/instance.sh"
DOCS_ROOT="$(pe_docs_root)"
if [ ! -d "$DOCS_ROOT/docs" ]; then
  printf 'ERROR: docs/ not found under DOCS_ROOT=%s\n' "$DOCS_ROOT" >&2
  printf '  → run from the repo root, or: DOCS_ROOT=/path/to/repo %s ...\n' "$(basename "$0")" >&2
  exit 1
fi

dest="$DOCS_ROOT/docs/plans/${slug}.md"
mkdir -p "$DOCS_ROOT/docs/plans"
if [ -e "$dest" ]; then
  echo "refusing to overwrite existing plan: $dest" >&2
  exit 1
fi

date_str="$(date +%F)"
sed -e "s|{{SLUG}}|${slug}|g" -e "s|{{DATE}}|${date_str}|g" \
  "$SKILL_DIR/templates/plan.md" > "$dest"

echo "created $dest"
