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

@test "handoff-status: a complete handoff still holding the template reads in-progress on the board (#46)" {
  setup_docs linear linear
  local f="$DOCS_ROOT/docs/handoffs/linear/phase-01-alpha.md"
  mkdir -p "$(dirname "$f")"
  printf -- '---\nplan: docs/plans/linear.md\nphase: 1\ntitle: alpha\nstatus: complete\n---\n# Phase 1\n\n## What this phase did\n<!-- 1–3 sentences + bullets of what shipped.\n     (a comment may span lines) -->\n\n## State now (verified)\nall green\n' > "$f"
  run pe_hostatus linear
  [ "$status" -eq 0 ]
  assert_contains "$output" "status=complete"
  assert_contains "$output" "IN PROGRESS: 1"
  run pg linear --lint
  assert_contains "$output" "phase 1: handoff-scaffold-complete"

  # A heading inside a code fence is not a section, and a deeper heading is
  # content: neither makes the section look written or empty on its own.
  printf -- '---\nplan: docs/plans/linear.md\nphase: 1\ntitle: alpha\nstatus: complete\n---\n## What this phase did\n```\n## not a heading\n```\n' > "$f"
  run pg linear --memory-block
  assert_contains "$output" "done: 1"

  # Written: done.
  printf -- '---\nplan: docs/plans/linear.md\nphase: 1\ntitle: alpha\nstatus: complete\n---\n## What this phase did\n<!-- template -->\nShipped the alpha.\n' > "$f"
  run pe_hostatus linear
  refute_contains "$output" "IN PROGRESS: 1"
  run pg linear --memory-block
  assert_contains "$output" "done: 1"

  # No such section at all is not a scaffold: a hand-written handoff stands.
  write_handoff linear 1 alpha complete
  run pg linear --memory-block
  assert_contains "$output" "done: 1"
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
