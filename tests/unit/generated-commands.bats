#!/usr/bin/env bats
# Every command a generated prompt prints must name the docs root it was read
# from.
#
# The skill scripts resolve their docs root from the RUNNING session's cwd
# (`pe_docs_root`: $DOCS_ROOT → the outermost superproject of the cwd → … →
# pwd). A generated line without `DOCS_ROOT=` therefore records its approval,
# outcome, task or lock wherever the reader's session happens to sit — not in
# the repository whose plan the line was generated from. Measured live on
# 2026-09-17 (autopilot-token-drain phase 8): a `gate-approve.sh` line pasted
# from a pe-hub plan into a session sitting in hub would have written
# `gate-status.md` into HUB; the operator noticed and hand-wrapped the command
# with an exported DOCS_ROOT. This file is the guard for that whole class.
#
# NOTE ON THE HARNESS: `tests/helpers/test_helper.bash` exports DOCS_ROOT for
# every runner, which is exactly why this defect was invisible to the suite for
# its whole life — the callee always found the right root in the environment.
# These tests read the generated TEXT, they never run it, so the ambient
# DOCS_ROOT cannot mask a missing prefix.
load ../helpers/test_helper

# Lines in `text` that invoke a skill script but do not name a docs root.
# bash 3.2: no `mapfile`, no `${var^^}`.
missing_docs_root() {
  printf '%s\n' "$1" | grep -F "$PE_SCRIPTS/" | grep -v 'DOCS_ROOT=' || true
}

@test "boot-prompt: every generated skill-script command carries its DOCS_ROOT (ai gate)" {
  setup_docs gatecheck gatecheck
  run pg gatecheck --boot-prompt 10
  [ "$status" -eq 0 ] || false
  assert_contains "$output" "gate-approve.sh gatecheck 10"
  bad="$(missing_docs_root "$output")"
  [ -z "$bad" ] || { echo "generated without DOCS_ROOT:" >&2; echo "$bad" >&2; false; }
}

@test "boot-prompt: every generated skill-script command carries its DOCS_ROOT (human gate)" {
  setup_docs gatecheck gatecheck
  run pg gatecheck --boot-prompt 5
  [ "$status" -eq 0 ] || false
  assert_contains "$output" "Gate card"
  bad="$(missing_docs_root "$output")"
  [ -z "$bad" ] || { echo "generated without DOCS_ROOT:" >&2; echo "$bad" >&2; false; }
}

@test "boot-prompt: every generated skill-script command carries its DOCS_ROOT (delegated gate)" {
  setup_docs gatecheck gatecheck
  PE_GATE_DELEGATE=1 run pg gatecheck --boot-prompt 5
  [ "$status" -eq 0 ] || false
  assert_contains "$output" "DELEGATED"
  bad="$(missing_docs_root "$output")"
  [ -z "$bad" ] || { echo "generated without DOCS_ROOT:" >&2; echo "$bad" >&2; false; }
}

@test "boot-prompt: every generated skill-script command carries its DOCS_ROOT (auto gate)" {
  setup_docs gatecheck gatecheck
  run pg gatecheck --boot-prompt 2
  [ "$status" -eq 0 ] || false
  assert_contains "$output" "GATED phase (auto-checked)"
  bad="$(missing_docs_root "$output")"
  [ -z "$bad" ] || { echo "generated without DOCS_ROOT:" >&2; echo "$bad" >&2; false; }
}

@test "boot-prompt: an ungated phase's lock, task and outcome lines carry it too" {
  setup_docs gatecheck gatecheck
  run pg gatecheck --boot-prompt 1
  [ "$status" -eq 0 ] || false
  # the three that a session is told to run for itself
  assert_contains "$output" "phase-lock.sh"
  assert_contains "$output" "phase-tasks.sh"
  assert_contains "$output" "phase-outcome.sh"
  bad="$(missing_docs_root "$output")"
  [ -z "$bad" ] || { echo "generated without DOCS_ROOT:" >&2; echo "$bad" >&2; false; }
}

@test "the gate line names the plan's OWN root, not the cwd the generator ran in" {
  setup_docs gatecheck gatecheck
  # Generate from a cwd whose git root is NOT the docs root — the live shape of
  # the defect: a session working in another repository asks for the prompt.
  elsewhere="$BATS_TEST_TMPDIR/elsewhere"
  mkdir -p "$elsewhere"
  run env -u PE_SCOPE sh -c "cd '$elsewhere' && DOCS_ROOT='$DOCS_ROOT' '$SYS_BASH' '$PE_SCRIPTS/phase-graph.sh' gatecheck --boot-prompt 10"
  [ "$status" -eq 0 ] || false
  assert_contains "$output" "DOCS_ROOT=$DOCS_ROOT"
  bad="$(missing_docs_root "$output")"
  [ -z "$bad" ] || { echo "generated without DOCS_ROOT:" >&2; echo "$bad" >&2; false; }
}

@test "next-phase-prompt: its printed commands are absolute and carry DOCS_ROOT" {
  setup_docs gatecheck gatecheck
  run pe_nextp gatecheck none
  [ "$status" -eq 0 ] || false
  # a bare `scripts/…` resolves against the READER's cwd, which is never
  # guaranteed to be the skill root
  bare="$(printf '%s\n' "$output" | grep -E '(^|[^/A-Za-z._-])scripts/[a-z-]+\.sh' || true)"
  [ -z "$bare" ] || { echo "relative skill-script paths printed:" >&2; echo "$bare" >&2; false; }
  bad="$(missing_docs_root "$output")"
  [ -z "$bad" ] || { echo "generated without DOCS_ROOT:" >&2; echo "$bad" >&2; false; }
}
