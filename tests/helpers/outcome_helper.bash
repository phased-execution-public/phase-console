#!/usr/bin/env bash
# The shared setup of the phase-outcome.sh suites (tests/unit/outcome*.bats),
# loaded after test_helper. outcome.bats held all of it until measured-console
# phase 7 split it into files under 400 lines, so the bash suite's shards stay
# even (tests/run-tests.sh runs them four at a time).

setup() {
  # FIRST, and before the exports below: five cases here compare the file
  # against an exact JSON literal, and a supervised session exports PE_TRACE_ID
  # and PE_SPAN_ID, which phase-outcome.sh correctly folds in as `trace`/`span`
  # (cases 41-43 assert exactly that). Without this the suite is green from a
  # terminal and red from inside a run — the one place it is most likely to be
  # run. `setup_docs` scrubs for the suites that use it; this one builds its own
  # environment, so it asks for itself.
  scrub_pe_env
  export PE_NOW="2026-08-10T21:10:03Z"
  export PE_OUTCOME_FILE="$BATS_TEST_TMPDIR/outcome.json"
  # The ruling ledger the runner would inject. Append-only, unlike the outcome
  # file, which is written whole and consumed.
  export PE_RULINGS_FILE="$BATS_TEST_TMPDIR/rulings.ndjson"
  # The session line is written only when a session id is known; this suite
  # may itself run inside a Claude session that exports one.
  unset PE_SESSION_ID CLAUDE_CODE_SESSION_ID
  # The unsupervised fallback writes into the console's state home for the
  # repository root — both pointed at the test's own directories.
  export XDG_STATE_HOME="$BATS_TEST_TMPDIR/state"
  export DOCS_ROOT="$BATS_TEST_TMPDIR/work"
  mkdir -p "$DOCS_ROOT"
}

# The identity rule of viewer/shared/instances.mjs, in bash: sha256(root)[:8]-basename.
inbox_dir() { # <slug>
  local id
  id="$(printf '%s' "$DOCS_ROOT" | shasum -a 256 | cut -c1-8)-$(basename "$DOCS_ROOT")"
  printf '%s/phase-console/runs/%s/%s/outcomes' "$XDG_STATE_HOME" "$id" "$1"
}

# The rulings ledger sits beside outcomes/: it is per PLAN, not per phase and
# not per run. Built from the id rather than from `inbox_dir`/.. — `..` only
# resolves through a directory that exists, and outcomes/ need not.
ledger_file() { # <slug>
  local id
  id="$(printf '%s' "$DOCS_ROOT" | shasum -a 256 | cut -c1-8)-$(basename "$DOCS_ROOT")"
  printf '%s/phase-console/runs/%s/%s/rulings.ndjson' "$XDG_STATE_HOME" "$id" "$1"
}
