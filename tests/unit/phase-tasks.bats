#!/usr/bin/env bats
# phase-tasks.sh — the task-list channel.
#
# The defect it exists for: the CLI stopped provisioning TodoWrite / TaskCreate
# / TaskUpdate to `claude -p` sessions around 2026-08-14 (zero calls across 946
# machine transcripts since), so Phase Console's "What it is doing" panel went
# permanently blank and every unattended session burned a pass searching for a
# tool that was not there. A shell script cannot be un-provisioned.
#
# These tests pin the WIRE FORMAT, which is a contract with
# viewer/server/runner/tasks.ts — that parser and this writer must be changed
# together, and viewer/test/phase-tasks.test.ts runs this very script and
# asserts the two agree end to end.
load ../helpers/test_helper

setup() {
  scrub_pe_env
  export PE_NOW="2026-08-24T00:10:00Z"
  export PE_TASKS_FILE="$BATS_TEST_TMPDIR/tasks.ndjson"
  unset PE_SESSION_ID CLAUDE_CODE_SESSION_ID
  export XDG_STATE_HOME="$BATS_TEST_TMPDIR/state"
  export DOCS_ROOT="$BATS_TEST_TMPDIR/work"
  mkdir -p "$DOCS_ROOT"
}

# The identity rule of viewer/shared/instances.mjs, in bash — the same one
# outcome.bats uses, because the two inboxes are siblings.
inbox_file() { # <slug> <phase>
  local id pad
  id="$(printf '%s' "$DOCS_ROOT" | shasum -a 256 | cut -c1-8)-$(basename "$DOCS_ROOT")"
  pad="$(printf '%02d' "$2")"
  printf '%s/phase-console/runs/%s/%s/tasks/phase-%s.ndjson' "$XDG_STATE_HOME" "$id" "$1" "$pad"
}

@test "tasks: create writes the exact JSON line, with a derived id" {
  run pe_tasks demo 8 create --subject "p8.task1 — write it"
  [ "$status" -eq 0 ]
  assert_contains "$output" "task create: demo phase 8 p8.task1"
  expected='{"version":1,"type":"task","slug":"demo","phase":8,"op":"create","id":"p8.task1","status":"pending","subject":"p8.task1 — write it","written_at":"2026-08-24T00:10:00Z"}'
  [ "$(cat "$PE_TASKS_FILE")" = "$expected" ]
}

@test "tasks: reset carries no id and no subject" {
  run pe_tasks demo 8 reset
  [ "$status" -eq 0 ]
  expected='{"version":1,"type":"task","slug":"demo","phase":8,"op":"reset","written_at":"2026-08-24T00:10:00Z"}'
  [ "$(cat "$PE_TASKS_FILE")" = "$expected" ]
}

@test "tasks: update states only what changed" {
  pe_tasks demo 8 create --subject "one" >/dev/null
  run pe_tasks demo 8 update --id p8.task1 --status completed
  [ "$status" -eq 0 ]
  expected='{"version":1,"type":"task","slug":"demo","phase":8,"op":"update","id":"p8.task1","status":"completed","written_at":"2026-08-24T00:10:00Z"}'
  [ "$(tail -1 "$PE_TASKS_FILE")" = "$expected" ]
}

@test "tasks: active-form and an explicit id ride along" {
  run pe_tasks demo 8 create --id custom-1 --subject "wire it" --status in_progress --active-form "Wiring it"
  [ "$status" -eq 0 ]
  expected='{"version":1,"type":"task","slug":"demo","phase":8,"op":"create","id":"custom-1","status":"in_progress","subject":"wire it","active_form":"Wiring it","written_at":"2026-08-24T00:10:00Z"}'
  [ "$(cat "$PE_TASKS_FILE")" = "$expected" ]
}

@test "tasks: the session id rides along when the session knows it" {
  PE_SESSION_ID="abc-123" run pe_tasks demo 8 create --subject "one"
  [ "$status" -eq 0 ]
  assert_contains "$(cat "$PE_TASKS_FILE")" '"session_id":"abc-123"'
}

@test "tasks: unnamed creates number in order, and reset restarts the count" {
  pe_tasks demo 8 create --subject one >/dev/null
  pe_tasks demo 8 create --subject two >/dev/null
  pe_tasks demo 8 create --subject three >/dev/null
  assert_contains "$(tail -1 "$PE_TASKS_FILE")" '"id":"p8.task3"'
  pe_tasks demo 8 reset >/dev/null
  run pe_tasks demo 8 create --subject "after"
  assert_contains "$(tail -1 "$PE_TASKS_FILE")" '"id":"p8.task1"'
}

# The engine-3 lesson, inherited: `08` is all-digits and is NOT a legal JSON
# number, so an unquoted `08` in the number position makes the whole line
# unparseable — and a session copies the padded number off its handoff filename.
@test "tasks: a zero-padded phase is normalised, not interpolated raw" {
  run pe_tasks demo 08 create --subject "one"
  [ "$status" -eq 0 ]
  assert_contains "$(cat "$PE_TASKS_FILE")" '"phase":8,'
  assert_contains "$(cat "$PE_TASKS_FILE")" '"id":"p8.task1"'
}

# A subject is free text and the file is NDJSON: a newline would split one
# record into two unparseable halves, and a quote would end the string early.
@test "tasks: a subject cannot forge a field or break the line" {
  run pe_tasks demo 8 create --subject 'evil","op":"create","id":"zzz" and a \back'
  [ "$status" -eq 0 ]
  [ "$(wc -l < "$PE_TASKS_FILE" | tr -d ' ')" = "1" ]
  assert_contains "$(cat "$PE_TASKS_FILE")" '"id":"p8.task1"'
  run pe_tasks demo 8 create --subject "$(printf 'line one\nline two')"
  [ "$(wc -l < "$PE_TASKS_FILE" | tr -d ' ')" = "2" ]
  assert_contains "$(tail -1 "$PE_TASKS_FILE")" '"subject":"line one line two"'
}

@test "tasks: unsupervised writes the console inbox and still prints the record" {
  unset PE_TASKS_FILE
  run pe_tasks demo 8 create --subject "one"
  [ "$status" -eq 0 ]
  assert_contains "$output" "PE_TASKS_FILE is not set"
  assert_contains "$output" '"op":"create"'
  [ -f "$(inbox_file demo 8)" ]
  assert_contains "$(cat "$(inbox_file demo 8)")" '"subject":"one"'
}

@test "tasks: refusals — the shapes that would produce a row nothing can address" {
  run pe_tasks demo 8 bogus;                              [ "$status" -eq 2 ]
  run pe_tasks demo x create --subject one;               [ "$status" -eq 2 ]
  run pe_tasks demo 8 create;                             [ "$status" -eq 2 ]
  run pe_tasks demo 8 create --subject one --status deleted; [ "$status" -eq 2 ]
  run pe_tasks demo 8 create --subject one --status nope; [ "$status" -eq 2 ]
  run pe_tasks demo 8 update --status completed;          [ "$status" -eq 2 ]
  run pe_tasks demo 8 update --id p8.task1;               [ "$status" -eq 2 ]
  run pe_tasks demo 8 update --id 'bad id' --status completed; [ "$status" -eq 2 ]
  run pe_tasks demo 8 reset --id x;                       [ "$status" -eq 2 ]
  run pe_tasks demo 8 create --subject one --bogus y;     [ "$status" -eq 2 ]
  [ ! -f "$PE_TASKS_FILE" ]
}

# `deleted` is a tombstone rather than a state: a task cannot be born deleted,
# but an update saying so removes the row.
@test "tasks: deleted is an update-only status" {
  run pe_tasks demo 8 update --id p8.task1 --status deleted
  [ "$status" -eq 0 ]
  assert_contains "$(cat "$PE_TASKS_FILE")" '"status":"deleted"'
}

# The whole promise of the channel: a session following this discipline never
# dies here. An unwritable target costs the record, never the run.
@test "tasks: an unwritable target prints the record and still exits 0" {
  mkdir -p "$BATS_TEST_TMPDIR/ro"
  export PE_TASKS_FILE="$BATS_TEST_TMPDIR/ro/tasks.ndjson"
  chmod 500 "$BATS_TEST_TMPDIR/ro"
  run pe_tasks demo 8 create --subject "one"
  chmod 700 "$BATS_TEST_TMPDIR/ro"
  [ "$status" -eq 0 ]
  assert_contains "$output" "could not be written"
  assert_contains "$output" '"op":"create"'
}
