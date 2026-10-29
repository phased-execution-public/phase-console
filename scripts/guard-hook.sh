#!/usr/bin/env bash
# The local guard — a run's second PreToolUse layer (measured-console phase 6, C4).
#
# Phase Console writes it into every run's settings file beside its HTTP hook,
# as a `command` hook with `onFailure: "block"`, for Bash, Write, Edit and
# NotebookEdit. The HTTP hook is the console's and answers nothing while the
# console is down; this one answers the console's deterministic denies with no
# console at all, so a baseline stays unwritable and a test undeleted however
# the console fares:
#   - a write to a protected file (e2e/baseline.json, status-ratchet.json,
#     known-reds.json, scripts/quarantine.env, any __snapshots__/ or *.snap);
#   - the deletion of a *.test.* or *.spec.* file, unless the phase's plan
#     section says `- **May delete tests:** yes` (the runner exports
#     PE_MAY_DELETE_TESTS=yes to that phase's session);
#   - a forged gate approval (PE_GATE_DOOR set, gate-status.md written).
#
# Contract (bash 3.2):
#   - reads the hook input on stdin; a call that names none of those files or
#     words is answered `{}` (no decision) without starting node — most calls;
#   - otherwise asks the console's own classifier,
#       node <skill>/viewer/server/runner/classify-cli.ts
#     with the input on stdin, and prints its JSON answer: a PreToolUse `deny`
#     with the reason, or `{}`;
#   - node is $PE_NODE (the runner sets it to its own) or the first on PATH;
#   - exits 0 with JSON whenever it decided; any other exit is a hook failure,
#     which `onFailure: "block"` turns into a blocked call — a guard that cannot
#     run does not wave the call through.

set -u

input=$(cat)

# The cheap gate: nothing the classifier could deny is named in the call.
case "$input" in
  *baseline.json*|*status-ratchet.json*|*known-reds.json*|*quarantine.env*|*__snapshots__*|*.snap*|*.test.*|*.spec.*|*PE_GATE_DOOR*|*gate-status.md*) ;;
  *) printf '{}\n'; exit 0 ;;
esac

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || exit 1
cli="$here/../viewer/server/runner/classify-cli.ts"
node_bin=${PE_NODE:-}
if [ -z "$node_bin" ] || [ ! -x "$node_bin" ]; then
  node_bin=$(command -v node 2>/dev/null) || node_bin=
fi
if [ -z "$node_bin" ]; then
  echo "guard-hook: no node to run the console's classifier" >&2
  exit 1
fi
[ -f "$cli" ] || { echo "guard-hook: $cli is missing" >&2; exit 1; }

printf '%s' "$input" | "$node_bin" "$cli"
