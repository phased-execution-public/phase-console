#!/usr/bin/env bash
# Print the per-plan handoff INDEX + per-file status + the live DAG board
# (done / ready / waiting), computed from the plan graph by phase-graph.sh.
# Usage: handoff-status.sh <slug>     (run from repo root owning docs/, or set DOCS_ROOT)
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
slug="${1:?usage: handoff-status.sh <slug>}"

# shellcheck source=/dev/null
. "$SKILL_DIR/scripts/instance.sh"
DOCS_ROOT="$(pe_docs_root)"
dir="$DOCS_ROOT/docs/handoffs/${slug}"

if [ ! -d "$dir" ]; then
  echo "no handoffs for '${slug}' at $dir" >&2
  exit 1
fi

if [ -e "$dir/INDEX.md" ]; then
  cat "$dir/INDEX.md"
  echo
fi

echo "=== per-file status (from frontmatter) ==="
shopt -s nullglob
found=0
for f in "$dir"/phase-*.md; do
  found=1
  # `|| true` on both: a handoff missing one of these keys makes grep exit 1,
  # pipefail propagates it and errexit kills the script mid-loop — no message, no
  # board, exit 1. SKILL.md makes this the first command of every phase-start, so
  # the failure lands on a fresh session's bootstrap. The `${st:-?}` defaults
  # below already render the missing case; they were simply never reached.
  st="$(grep -m1 '^status:' "$f" | sed 's/^status:[[:space:]]*//;s/[[:space:]]*#.*$//' || true)"
  nx="$(grep -m1 '^next_phase:' "$f" | sed 's/^next_phase:[[:space:]]*//;s/[[:space:]]*#.*$//' || true)"
  printf '%-42s status=%-12s next=%s\n' "$(basename "$f")" "${st:-?}" "${nx:-?}"
done
[ "$found" = 0 ] && echo "(no phase handoffs yet)"

# Live DAG board: which phases are done / ready / waiting, computed from the plan
# graph + these statuses. This is the authoritative "what can I start now" view —
# it understands concurrent + out-of-order progress, not just a linear cursor.
if [ -x "$SKILL_DIR/scripts/phase-graph.sh" ] || [ -f "$SKILL_DIR/scripts/phase-graph.sh" ]; then
  bash "$SKILL_DIR/scripts/phase-graph.sh" "$slug" 2>/dev/null || true
fi
exit 0
