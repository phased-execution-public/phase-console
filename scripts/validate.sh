#!/usr/bin/env bash
# Deterministic validator for a phased-execution plan + its handoffs.
#   F1/F2/F3 : structural lint of the plan (delegated to phase-graph.sh --lint).
#   F10      : handoff body + consistency checks — valid status, required
#              sections present, and depends_on agreeing with the plan graph.
#
# Usage: validate.sh <slug>     (run from the repo root, or set DOCS_ROOT)
# Exit 0 = valid, non-zero = problems (printed to stderr).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
slug="${1:?usage: validate.sh <slug>}"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/instance.sh"
DOCS_ROOT="$(pe_docs_root)"
BASH_BIN="${BASH:-bash}"

# 0) Closed plans are not validated. Validation exists to keep work runnable, and a
# closed plan has no work; without this, an abandoned plan flunks its handoff checks
# forever and there is no way to make it stop short of finishing what was abandoned.
# Ask the engine rather than re-reading frontmatter — closure is defined in one place.
if closed="$("$BASH_BIN" "$SCRIPT_DIR/phase-graph.sh" "$slug" --closed 2>/dev/null)"; then
  # G13: even a closed plan gets a frontmatter SHAPE check, warning tier only.
  # A pasted-over `status:` line (a prompt fragment where the value should be)
  # makes the board silently read the phase as not-started forever — and a
  # closed plan is exactly where nobody would otherwise look again. Warnings
  # go to stderr; the exit code stays 0 (closure means no gate).
  ho_dir="$DOCS_ROOT/docs/handoffs/$slug"
  if [ -d "$ho_dir" ]; then
    for f in "$ho_dir"/phase-*.md; do
      [ -e "$f" ] || continue
      st="$(grep -m1 '^status:' "$f" | sed 's/^status:[[:space:]]*//; s/[[:space:]]*#.*$//' || true)"
      case "$st" in
        complete|in-progress|blocked|pending) : ;;
        *) printf '  ⚠ %s: status "%.60s" is not one of complete|in-progress|blocked|pending — the board reads this phase as not-started\n' \
             "$(basename "$f")" "${st:-(none)}" >&2 ;;
      esac
    done
  fi
  echo "VALIDATE SKIPPED (${closed#closed }): $slug is closed — reopen it to validate again"
  exit 0
fi

# 1) Structural lint of the plan (aborts here on F1/F2/F3 via the engine's exit code).
#
# The engine answers with a code that is a VERDICT: 0 clean, 1 issues, each
# named on stderr. Anything else is the engine failing to RUN, and the two are
# not the same fact. `set -e` used to hand the difference on unchanged, so the
# bash 3.2 allocator death (#17) reached a plan author as exit 133 over an
# empty stderr — which reads as "nothing to fix" to a person and as a lint
# failure to a console. Name it, and answer with a code of our own (70,
# EX_SOFTWARE) so no caller can mistake it for a statement about the plan.
lint_status=0
"$BASH_BIN" "$SCRIPT_DIR/phase-graph.sh" "$slug" --lint || lint_status=$?
if [ "$lint_status" -ge 2 ]; then
  if [ "$lint_status" -ge 128 ]; then
    printf "VALIDATE UNRUN: the engine's lint crashed (signal %s) — run it under bash 5 or report the plan\n" \
      "$((lint_status - 128))" >&2
  else
    printf "VALIDATE UNRUN: the engine's lint crashed (exit %s) — run it under bash 5 or report the plan\n" \
      "$lint_status" >&2
  fi
  exit 70
fi
[ "$lint_status" -eq 0 ] || exit "$lint_status"

# 2) Handoff body + consistency checks (F10).
ho_dir="$DOCS_ROOT/docs/handoffs/$slug"
problems=0
if [ -d "$ho_dir" ]; then
  for f in "$ho_dir"/phase-*.md; do
    [ -e "$f" ] || continue
    base="$(basename "$f")"

    st="$(grep -m1 '^status:' "$f" | sed 's/^status:[[:space:]]*//; s/[[:space:]]*#.*$//' || true)"
    case "$st" in
      complete|in-progress|blocked|pending) : ;;
      *) echo "  ✗ $base: invalid/missing status: '${st:-(none)}'" >&2; problems=$((problems + 1)) ;;
    esac

    # The handoff must be actionable: it needs the boot section (the next phase(s)
    # prompts, or the final closeout). Prose section NAMES vary legitimately across
    # handoffs, so don't enforce them rigidly — bootstrap-ability is the contract.
    grep -qiE 'start next phase|final phase|closeout' "$f" \
      || { echo "  ✗ $base: missing the '▶ Start next phase(s)' boot section" >&2; problems=$((problems + 1)); }

    # …and it must not swallow the handoff (control-tower phase 85, #115). The
    # section is a hand-off to OTHER sessions; tfar phase 32's ran 1,090 of 1,350
    # lines — eight whole prompts, ~85 % copies of each other — and buried
    # `## Outstanding` at line 1,333. Over 300 lines, or over 40 % of the file, is
    # named here: a WARNING, never a problem, so the exit code is untouched. A
    # handoff written before the shared boot existed stays as it is. Fences are
    # skipped, since a `## ` inside a prompt is not a heading.
    awk -v base="$base" '
      /^```/ || /^~~~/ { fence = !fence }
      !fence && /^## / {
        if (ins) { sec += NR - start; ins = 0 }
        if ($0 ~ /[Ss]tart next phase/) { ins = 1; start = NR }
      }
      END {
        if (ins) sec += NR - start + 1
        if (NR == 0 || sec == 0) exit
        over = ""
        if (sec > 300) over = "300 lines"
        if (100 * sec > 40 * NR) over = (over == "" ? "" : over " and ") "40% of the handoff"
        if (over != "")
          printf "  ⚠ %s: its \047▶ Start next phase(s)\047 section is %d of %d lines (%d%%) — over %s (#115: a fan-out writes the shared boot once, then a block per phase)\n", base, sec, NR, int(100 * sec / NR), over
      }' "$f" >&2

    # …and a person's `!` line must not point into a console RUN TREE
    # (control-tower phase 90, #123). A parked phase's handoff gave the operator
    # production apply lines that `cd` into the run's mirror, and the console
    # pruned that mirror at the end of the very session that wrote them. A run
    # tree is pruned on the console's schedule; an errand tree
    # (`.worktrees/hand/<slug>/p<N>-errand`, POST /api/run/<slug>/errand-tree)
    # is removed only by a person. A WARNING, like the one above.
    awk -v base="$base" '
      {
        line = $0
        sub(/^[[:space:]>*+-]*`?/, "", line)
        if (line ~ /^![[:space:]]*[^[:space:]=]/ && ($0 ~ /\/\.worktrees\/runs\// || $0 ~ /\/phase-console\/runs\/.*\/worktrees\//)) {
          printf "  ⚠ %s:%d: a `!` line points into a console run tree, which the console prunes on its own schedule — prepare an errand tree (POST /api/run/<slug>/errand-tree {phase}) under .worktrees/hand/ and point there instead (#123)\n", base, NR
        }
      }' "$f" >&2

    phnum="$(grep -m1 '^phase:' "$f" | sed 's/^phase:[[:space:]]*//; s/[[:space:]]*#.*$//' || true)"
    if [ -n "$phnum" ]; then
      # `|| true` on both: under `set -eo pipefail`, a handoff with NO
      # depends_on line made grep fail the pipeline and killed this validator
      # mid-loop — exit 1 with no ✗ and no summary, the exact silent-red shape
      # this script exists to prevent. A missing line must be REPORTED as a
      # disagreement, not die unexplained.
      want="$("$BASH_BIN" "$SCRIPT_DIR/phase-graph.sh" "$slug" --deps "$phnum" 2>/dev/null | tr ' ' '\n' | sed '/^$/d' | sort -n | tr '\n' ' ' | sed 's/ *$//' || true)"
      got="$(grep -m1 '^depends_on:' "$f" | sed 's/^depends_on:[[:space:]]*\[//; s/\].*$//; s/,/ /g' | tr '\n' ' ' | tr -s ' ' | tr ' ' '\n' | sed '/^$/d' | sort -n | tr '\n' ' ' | sed 's/ *$//' || true)"
      [ "$want" = "$got" ] || { echo "  ✗ $base: depends_on [$got] disagrees with plan graph [$want]" >&2; problems=$((problems + 1)); }
    fi
  done
fi

if [ "$problems" -gt 0 ]; then
  echo "VALIDATE FAIL: $slug — $problems handoff problem(s)" >&2
  exit 1
fi
echo "VALIDATE OK: $slug"
