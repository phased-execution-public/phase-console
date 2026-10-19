#!/usr/bin/env bats
# Board rendering: F6 model-aware batch budget + the structure-problems block.
load ../helpers/test_helper

@test "board: batches reflect the plan's Session budget model (F6, opus -> ~200K)" {
  setup_docs budgeted budgeted
  run pg budgeted
  assert_contains "$output" "~200K"
}

@test "board: batches default to ~40K when no Session budget is declared" {
  setup_docs sizes sizes
  run pg sizes
  assert_contains "$output" "~40K"
}

@test "board: a clean plan shows no STRUCTURE PROBLEMS block" {
  setup_docs diamond diamond
  run pg diamond
  refute_contains "$output" "STRUCTURE PROBLEMS"
}

@test "board: a cycle plan shows the STRUCTURE PROBLEMS block" {
  setup_docs bad-cycle loop
  run pg loop
  assert_contains "$output" "STRUCTURE PROBLEMS"
}

# --- #288: a blocked handoff ahead of its own unmet dependency ----------------
# The handoff word decides the BUCKET (stuck), but the `blocked:` line must
# still say what the phase waits on, so the console admits nothing it holds.

@test "board: a stuck phase whose dependency is not done is named on the blocked line (#288)" {
  setup_docs outoforder outoforder
  write_handoff outoforder 4 mid blocked
  run pg outoforder --memory-block
  assert_contains "$output" "stuck: 4"
  assert_contains "$output" "4<-1(not-done)"
}

@test "board: a stuck phase whose dependencies are done is not on the blocked line (#288)" {
  setup_docs outoforder outoforder
  write_handoff outoforder 1 base complete
  write_handoff outoforder 4 mid blocked
  run pg outoforder --memory-block
  assert_contains "$output" "stuck: 4"
  refute_contains "$output" "4<-"
}

@test "board: an in-progress phase ahead of its dependency is named too (#288)" {
  setup_docs outoforder outoforder
  write_handoff outoforder 5 tip in-progress
  run pg outoforder --memory-block
  assert_contains "$output" "in-progress: 5"
  assert_contains "$output" "5<-4(not-done)"
}
