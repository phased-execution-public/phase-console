#!/usr/bin/env bash
# Scaffold docs/plans/<slug>.md from the skill template.
# Usage: new-plan.sh <slug>     (run from the repo root that owns docs/, or set DOCS_ROOT)
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
slug="${1:?usage: new-plan.sh <slug>}"

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
