#!/usr/bin/env bash
# Deterministic test entrypoint for the phased-execution skill.
# Runs the bats unit + integration suites (scripts under test execute under
# /bin/bash 3.2 via the test helper). Optional shellcheck lint if available.
#
# It prints a summary, not the suites (measured-console phase 6, the audit's
# A4 — a session pays for every line it reads): per section its counts and the
# `not ok` line of each failing test, and on red the path of the log that holds
# everything — shellcheck's findings and both suites' full TAP. The log lives
# under ${TMPDIR:-/tmp}, never in the tree, and is removed when all is green.
# Exit status is unchanged: 0 green, 1 any section red, 127 without bats.
#
# A section runs as RUN_TESTS_JOBS (default 4) bats processes at once, its files
# dealt by size so no shard waits on another (measured-console phase 7, the
# audit's C1). Not `bats --jobs`: that needs GNU parallel, which a stock
# macOS has not, and a gate that needs an extra install is a gate nobody runs.
# RUN_TESTS_JOBS=1 is one bats over the directory, as before.
#
# RUN_TESTS_ONLY="<file> …" runs those .bats files alone, as one section named
# `selected` (measured-console phase 15): the phase tier's selected form of this
# line (scripts/verify-select.env). Paths are relative to the repository root.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
JOBS="${RUN_TESTS_JOBS:-4}"
# Read once and taken out of the environment: the suites below run run-tests.sh
# themselves (gates.bats), and a selection must never reach a nested run.
ONLY="${RUN_TESTS_ONLY:-}"
unset RUN_TESTS_ONLY
case "$JOBS" in ''|*[!0-9]*|0) JOBS=1 ;; esac

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
TMP_BASE="${TMPDIR:-/tmp}"
LOG_DIR="$(mktemp -d "${TMP_BASE%/}/phase-console-run-tests.XXXXXX")"
LOG="$LOG_DIR/run-tests.log"
: > "$LOG"
# How many failing tests a section names here; the rest are in the log.
NAME_CAP=30

# section_summary <title> <tap-file> <rc> — one counts line, then each failing
# test's `not ok` line (capped), from a bats --tap stream.
section_summary() {
  awk -v title="$1" -v rc="$3" -v cap="$NAME_CAP" '
    /^ok [0-9]+/ { if ($0 ~ /# [Ss][Kk][Ii][Pp]/) skipped++; else ok++; next }
    /^not ok [0-9]+/ { bad++; if (bad <= cap) names[bad] = $0; next }
    END {
      printf "== %s: %d ok, %d not ok, %d skipped ==\n", title, ok, bad, skipped
      for (i = 1; i <= bad && i <= cap; i++) print names[i]
      if (bad > cap) printf "… and %d more not ok (the log has them all)\n", bad - cap
      if (rc != 0 && bad == 0) printf "%s exited %s naming no failing test — read the log\n", title, rc
    }' "$2"
}

# shard_files <jobs> <file>… — one line per shard, its files space-separated:
# largest file first, each to the shard holding the fewest bytes so far.
shard_files() {
  local jobs=$1; shift
  local f
  for f in "$@"; do printf '%s %s\n' "$(wc -c < "$f" | tr -d ' ')" "$f"; done \
    | sort -rn | awk -v jobs="$jobs" '
      { best = 1; for (i = 2; i <= jobs; i++) if (load[i] < load[best]) best = i
        load[best] += $1; files[best] = files[best] (files[best] == "" ? "" : " ") $2 }
      END { for (i = 1; i <= jobs; i++) if (files[i] != "") print files[i] }'
}

# run_section <title> <dir> — bats over one directory, its TAP into the log.
run_section() {
  local title=$1 tap="$LOG_DIR/$1.tap" rc=0 files=() n=0 shard pids="" pid
  local f
  if [ "$#" -gt 2 ]; then
    shift 2; for f in "$@"; do [ -f "$f" ] && files+=("$f"); done
  else
    for f in "$2"/*.bats; do [ -f "$f" ] && files+=("$f"); done
  fi
  if [ "${#files[@]}" -eq 0 ]; then
    : > "$tap"
  elif [ "$JOBS" -le 1 ] || [ "${#files[@]}" -le 1 ]; then
    bats --tap "${files[@]}" > "$tap" 2>&1 || rc=$?
  else
    # Word-split on purpose: a shard line is its files, and no test file's name holds a space.
    while IFS= read -r shard; do
      n=$((n + 1))
      # shellcheck disable=SC2086
      bats --tap $shard > "$tap.$n" 2>&1 &
      pids="$pids $!"
    done < <(shard_files "$JOBS" "${files[@]}")
    for pid in $pids; do wait "$pid" || rc=1; done
    : > "$tap"
    local k=1; while [ "$k" -le "$n" ]; do cat "$tap.$k" >> "$tap"; rm -f "$tap.$k"; k=$((k + 1)); done
  fi
  { echo "== $title =="; cat "$tap"; } >> "$LOG"
  section_summary "$title" "$tap" "$rc"
  rm -f "$tap"
  [ "$rc" -eq 0 ] || fail=1
}

if command -v shellcheck >/dev/null 2>&1; then
  # -e SC1090/SC1091: dynamic 'source' paths are intentional. --severity=warning
  # drops info/style noise (intentional literal-backtick printf + word-split lists).
  sc_rc=0
  shellcheck -x -e SC1090,SC1091 --severity=warning "$HERE"/../scripts/*.sh > "$LOG_DIR/shellcheck.out" 2>&1 || sc_rc=$?
  { echo "== shellcheck =="; cat "$LOG_DIR/shellcheck.out"; } >> "$LOG"
  if [ "$sc_rc" -eq 0 ]; then
    echo "== shellcheck: clean =="
  else
    fail=1
    echo "== shellcheck: $(grep -c '^In ' "$LOG_DIR/shellcheck.out" || true) finding(s) in $(grep '^In ' "$LOG_DIR/shellcheck.out" | awk '{print $2}' | sort -u | wc -l | tr -d ' ') file(s) =="
  fi
  rm -f "$LOG_DIR/shellcheck.out"
else
  echo "== shellcheck (skipped — not installed) =="
fi

if [ -n "$ONLY" ]; then
  only=()
  for f in $ONLY; do
    case "$f" in /*) ;; *) f="$HERE/../$f" ;; esac
    [ -f "$f" ] || { echo "run-tests: RUN_TESTS_ONLY names $f, which is not a file" >&2; exit 2; }
    only+=("$f")
  done
  run_section selected "$HERE" "${only[@]}"
else
  run_section unit "$HERE/unit"
  run_section integration "$HERE/integration"
fi

if [ "$fail" -eq 0 ]; then
  echo "ALL GREEN"
  rm -rf "$LOG_DIR"
else
  echo "FAILURES ABOVE — the whole output: $LOG"
fi
exit "$fail"
