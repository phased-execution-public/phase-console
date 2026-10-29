#!/usr/bin/env bats
# phase-outcome.sh ruling — what a session DECIDED, as opposed to how it ended,
# and --remember, which turns a ruling into a standing answer.
# (One of five files since measured-console phase 7; the shared setup is tests/helpers/outcome_helper.bash.)
load ../helpers/test_helper
load ../helpers/outcome_helper

# ---- rulings: what a session DECIDED, not how it ended ---------------------

@test "ruling: writes ONE exact NDJSON line, and the next one appends" {
  run pe_outcome demo 5 ruling --kind deviation --what "kept the old field" \
    --why "a reader predating it still exists" --cost-if-wrong "one dead branch"
  [ "$status" -eq 0 ]
  assert_contains "$output" "ruling recorded: demo phase 5 (deviation)"
  # The id is sha256("<slug> <phase> <at> <what>") cut to 12 — the digest
  # viewer/server/runner/rulings.ts derives, stamped so acks and promote name it.
  expected='{"version":1,"type":"ruling","id":"87b9eff77673","slug":"demo","phase":5,"kind":"deviation","what":"kept the old field","why":"a reader predating it still exists","cost_if_wrong":"one dead branch","at":"2026-08-10T21:10:03Z"}'
  [ "$(cat "$PE_RULINGS_FILE")" = "$expected" ]

  PE_NOW="2026-08-10T22:00:00Z" run pe_outcome demo 6 ruling --what "left the sub-case to phase 9"
  [ "$status" -eq 0 ]
  # Appended, not replaced: two lines, the first untouched.
  [ "$(wc -l < "$PE_RULINGS_FILE" | tr -d ' ')" = "2" ]
  [ "$(head -1 "$PE_RULINGS_FILE")" = "$expected" ]
  second='{"version":1,"type":"ruling","id":"7edead64f86b","slug":"demo","phase":6,"kind":"ambiguity","what":"left the sub-case to phase 9","at":"2026-08-10T22:00:00Z"}'
  [ "$(tail -1 "$PE_RULINGS_FILE")" = "$second" ]
}

@test "ruling --for: a deferral carries its addressee, and defaults to \`next\`" {
  run pe_outcome demo 5 ruling --kind deferral --what "left the second decoder" --for 9
  [ "$status" -eq 0 ]
  assert_contains "$(cat "$PE_RULINGS_FILE")" '"for":"9"'

  rm -f "$PE_RULINGS_FILE"
  # A deferral with no addressee is for whoever comes next — which is what a
  # session means when it says "left for later" and does not say for whom. The
  # field is written either way, so a reader never has to know the default.
  run pe_outcome demo 5 ruling --kind deferral --what "left the second decoder"
  [ "$status" -eq 0 ]
  assert_contains "$(cat "$PE_RULINGS_FILE")" '"for":"next"'

  rm -f "$PE_RULINGS_FILE"
  run pe_outcome demo 5 ruling --kind deferral --what "a fact for everyone" --for all
  [ "$status" -eq 0 ]
  assert_contains "$(cat "$PE_RULINGS_FILE")" '"for":"all"'
}

@test "ruling --for: refused on the other two kinds, and on an unreadable addressee" {
  # An ambiguity and a deviation are a session explaining ITSELF; only a
  # deferral is addressed to somebody, so `--for` on the other two is a note
  # nothing would ever deliver.
  run pe_outcome demo 5 ruling --kind ambiguity --what x --for 9
  [ "$status" -eq 2 ]
  assert_contains "$output" "--for belongs to --kind deferral"
  [ ! -f "$PE_RULINGS_FILE" ]

  run pe_outcome demo 5 ruling --kind deviation --what x --for next
  [ "$status" -eq 2 ]

  run pe_outcome demo 5 ruling --kind deferral --what x --for "the next person"
  [ "$status" -eq 2 ]
  assert_contains "$output" "invalid --for"
  [ ! -f "$PE_RULINGS_FILE" ]

  run pe_outcome demo 5 ruling --kind deferral --what x --for 0
  [ "$status" -eq 2 ]
}

@test "ruling: --kind defaults to ambiguity and an unknown kind exits 2 without writing" {
  run pe_outcome demo 5 ruling --what "a choice"
  [ "$status" -eq 0 ]
  assert_contains "$(cat "$PE_RULINGS_FILE")" '"kind":"ambiguity"'

  rm -f "$PE_RULINGS_FILE"
  run pe_outcome demo 5 ruling --kind opinion --what "a choice"
  [ "$status" -eq 2 ]
  assert_contains "$output" "invalid --kind: opinion"
  [ ! -f "$PE_RULINGS_FILE" ]
}

@test "ruling: newlines, quotes and backslashes are sanitised into ONE json line" {
  what="$(printf 'chose "A"\nover B\\C')"
  run pe_outcome demo 5 ruling --what "$what"
  [ "$status" -eq 0 ]
  [ "$(wc -l < "$PE_RULINGS_FILE" | tr -d ' ')" = "1" ]
  assert_contains "$(cat "$PE_RULINGS_FILE")" '"what":"chose \"A\" over B\\C"'
}

@test "ruling: --what is required, and the outcome flags are refused rather than ignored" {
  run pe_outcome demo 5 ruling
  [ "$status" -eq 2 ]
  assert_contains "$output" "--what is required"

  run pe_outcome demo 5 ruling --what x --watch "gh:a#run/1"
  [ "$status" -eq 2 ]
  assert_contains "$output" "belong to an outcome status"

  run pe_outcome demo 5 ruling --what x --wait-minutes 30
  [ "$status" -eq 2 ]
  assert_contains "$output" "belong to an outcome status"

  # ...and the other way round: a ruling flag on a real status is an error too.
  run pe_outcome demo 5 complete --what x
  [ "$status" -eq 2 ]
  assert_contains "$output" "only make sense with ruling"
  [ ! -f "$PE_RULINGS_FILE" ]
}

@test "ruling: the session id rides along, sanitised, and is omitted when unknown" {
  PE_SESSION_ID='we"ird id' run pe_outcome demo 5 ruling --what x
  [ "$status" -eq 0 ]
  assert_contains "$(cat "$PE_RULINGS_FILE")" '"session_id":"weirdid"'
  rm -f "$PE_RULINGS_FILE"
  run pe_outcome demo 5 ruling --what x
  refute_contains "$(cat "$PE_RULINGS_FILE")" 'session_id'
}

@test "ruling: without PE_RULINGS_FILE the line goes to this root's ledger AND to stdout, exit stays 0" {
  unset PE_RULINGS_FILE
  run pe_outcome demo 5 ruling --what "a choice"
  [ "$status" -eq 0 ]
  assert_contains "$output" '"type":"ruling"'
  assert_contains "$output" 'PE_RULINGS_FILE is not set'
  f="$(ledger_file demo)"
  [ -f "$f" ]
  assert_contains "$(cat "$f")" '"what":"a choice"'
}

@test "ruling: an unwritable state home still prints the line and exits 0" {
  unset PE_RULINGS_FILE
  export XDG_STATE_HOME="/dev/null/nowhere"
  run pe_outcome demo 5 ruling --what "a choice"
  [ "$status" -eq 0 ]
  assert_contains "$output" '"what":"a choice"'
  assert_contains "$output" 'could not be written'
}

# ---- rulings: --remember, the feedback loop (chapter 10 ZTD-7) ---------------

@test "ruling --remember plan: writes the ## Decisions row (source ruling) and acks the ruling with --by" {
  setup_docs decisions decisions
  # setup_docs scrubs the PE_* environment, the ledger path included.
  export PE_RULINGS_FILE="$BATS_TEST_TMPDIR/rulings.ndjson" PE_NOW="2026-08-10T21:10:03Z" PE_TODAY=2026-09-14
  run pe_outcome decisions 2 ruling --what "the window is the cap" --why "the plan says so" \
    --needs waits --remember plan --by op
  [ "$status" -eq 0 ]
  assert_contains "$output" "remembered for plan decisions: waits"
  id="$(sed -n 's/.*"id":"\([0-9a-f]*\)".*/\1/p' "$PE_RULINGS_FILE" | head -1)"
  [ "${#id}" -eq 12 ]
  # The twin row: value = --what, source ruling, evidence the id, plan-wide.
  grep -q "| \`waits\` | the window is the cap | op | answered | yes | ruling | ruling $id | — |" \
    "$DOCS_ROOT/docs/handoffs/decisions/decisions.md"
  # The ledger: the ruling line, then ONE ack naming it and its author.
  [ "$(wc -l < "$PE_RULINGS_FILE" | tr -d ' ')" = "2" ]
  [ "$(tail -1 "$PE_RULINGS_FILE")" = "{\"version\":1,\"type\":\"ack\",\"id\":\"$id\",\"at\":\"2026-08-10T21:10:03Z\",\"by\":\"op\"}" ]
  # And the engine reads the promoted row back.
  run pg decisions --decisions
  assert_contains "$output" "$(printf 'waits\tanswered\top\tyes\truling\tthe window is the cap')"
}

@test "ruling --remember: needs a key, plan|global only, refused on an outcome status" {
  run pe_outcome demo 5 ruling --what x --remember plan
  [ "$status" -eq 2 ]
  assert_contains "$output" "--remember plan needs --needs <key>"
  run pe_outcome demo 5 ruling --what x --needs gates --remember always
  [ "$status" -eq 2 ]
  assert_contains "$output" "invalid --remember: always"
  run pe_outcome demo 5 complete --remember plan
  [ "$status" -eq 2 ]
  assert_contains "$output" "only make sense with ruling"
  [ ! -f "$PE_RULINGS_FILE" ]
}

@test "ruling --remember global: with no console answering, the ruling is still recorded and the exit names the fallback" {
  PHASE_CONSOLE_URL="http://127.0.0.1:1" run pe_outcome demo 5 ruling --what waive --needs qa.exhausted --remember global
  [ "$status" -eq 1 ]
  assert_contains "$output" "no console answers at http://127.0.0.1:1"
  assert_contains "$output" "Settings"
  # Recorded first — the request failing is not the ruling failing.
  assert_contains "$(cat "$PE_RULINGS_FILE")" '"decisionKey":"qa.exhausted"'
  [ "$(wc -l < "$PE_RULINGS_FILE" | tr -d ' ')" = "1" ]
}
