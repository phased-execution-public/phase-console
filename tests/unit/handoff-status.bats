#!/usr/bin/env bats
# coverage-14 — scripts/handoff-status.sh had no test at all, though SKILL.md
# makes it step 1 of every phase-start: "Bootstrap from disk only: run
# scripts/handoff-status.sh <slug>". A fresh session's first command is not the
# place to discover that a missing frontmatter key kills the script under
# `set -euo pipefail` with no message, no board and exit 1 (engine-8).
load ../helpers/test_helper

@test "handoff-status: prints INDEX.md when there is one" {
  setup_docs linear linear
  printf '# Handoff INDEX — linear\n\nrow one\n' > "$DOCS_ROOT/docs/handoffs/linear/INDEX.md"
  run pe_hostatus linear
  [ "$status" -eq 0 ]
  assert_contains "$output" "Handoff INDEX — linear"
}

@test "handoff-status: one status= / next= line per handoff, from the frontmatter" {
  setup_docs linear linear
  write_handoff linear 1 alpha complete
  write_handoff linear 2 beta in-progress
  run pe_hostatus linear
  [ "$status" -eq 0 ]
  assert_contains "$output" "phase-01-alpha.md"
  assert_contains "$output" "status=complete"
  assert_contains "$output" "phase-02-beta.md"
  assert_contains "$output" "status=in-progress"
}

@test "handoff-status: says so when the folder holds no handoffs yet" {
  setup_docs linear linear
  run pe_hostatus linear
  [ "$status" -eq 0 ]
  assert_contains "$output" "(no phase handoffs yet)"
}

@test "handoff-status: appends the live DAG board" {
  setup_docs linear linear
  write_handoff linear 1 alpha complete
  run pe_hostatus linear
  [ "$status" -eq 0 ]
  assert_contains "$output" "Phase graph — linear"
  assert_contains "$output" "READY NOW"
}

@test "handoff-status: a handoff with no next_phase: still renders — and the board still prints" {
  # engine-8. `st=` and `nx=` were `grep | sed` pipelines with no `|| true`, so a
  # handoff missing either key made grep exit 1, pipefail propagated it, errexit
  # killed the script mid-loop, and the caller got exit 1 and nothing else. The
  # `${nx:-?}` default two lines below was simply never reached.
  setup_docs linear linear
  write_handoff linear 1 alpha complete     # write_handoff writes no next_phase:
  write_handoff linear 2 beta complete
  run pe_hostatus linear
  [ "$status" -eq 0 ]
  assert_contains "$output" "next=?"
  assert_contains "$output" "phase-02-beta.md"
  assert_contains "$output" "Phase graph — linear"
}

@test "handoff-status: a handoff with no status: line renders as unknown, not as a crash" {
  setup_docs linear linear
  printf -- '---\nplan: docs/plans/linear.md\nphase: 1\n---\n# Phase 1\n' \
    > "$DOCS_ROOT/docs/handoffs/linear/phase-01-alpha.md"
  run pe_hostatus linear
  [ "$status" -eq 0 ]
  assert_contains "$output" "status=?"
}

@test "handoff-status: an unknown slug fails with a message, not a stack" {
  setup_docs linear linear
  run pe_hostatus nosuchplan
  [ "$status" -eq 1 ]
  assert_contains "$output" "no handoffs for 'nosuchplan'"
}
