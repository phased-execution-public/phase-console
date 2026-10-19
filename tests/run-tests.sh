#!/usr/bin/env bash
# Deterministic test entrypoint for the phased-execution skill.
# Runs the bats unit + integration suites (scripts under test execute under
# /bin/bash 3.2 via the test helper). Optional shellcheck lint if available.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

if ! command -v bats >/dev/null 2>&1; then
  cat >&2 <<'MSG'
ERROR: bats-core is not installed (required to run the test suite).
  macOS:  brew install bats-core
  npm:    npm install -g bats
Then re-run: tests/run-tests.sh
MSG
  exit 127
fi

# A session Phase Console supervises runs this with the console's variables
# exported — the run's owner, lock mirror, channel files and issue policy — and
# each of them steers a script under test (#230: a planted PE_ISSUES_SOURCE
# turned three issue-policy tests red). So every PE_* variable, and DOCS_ROOT,
# leaves the environment before bats starts, and the names are printed: a test
# sets what it needs, and nothing a session carries leaks in.
scrubbed=""
for name in $(compgen -e); do
  case "$name" in
    PE_*|DOCS_ROOT) unset "$name"; scrubbed="$scrubbed $name" ;;
  esac
done
if [ -n "$scrubbed" ]; then
  echo "== environment: scrubbed${scrubbed} =="
else
  echo "== environment: no PE_* or DOCS_ROOT to scrub =="
fi

fail=0

if command -v shellcheck >/dev/null 2>&1; then
  echo "== shellcheck =="
  # -e SC1090/SC1091: dynamic 'source' paths are intentional. --severity=warning
  # drops info/style noise (intentional literal-backtick printf + word-split lists).
  shellcheck -x -e SC1090,SC1091 --severity=warning "$HERE"/../scripts/*.sh || fail=1
else
  echo "== shellcheck (skipped — not installed) =="
fi

echo "== unit =="
bats "$HERE/unit" || fail=1

echo "== integration =="
bats "$HERE/integration" || fail=1

if [ "$fail" -eq 0 ]; then echo "ALL GREEN"; else echo "FAILURES ABOVE"; fi
exit "$fail"
