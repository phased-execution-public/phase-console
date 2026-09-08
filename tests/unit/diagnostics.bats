#!/usr/bin/env bats
# Engine-level diagnostics on the board + a --lint mode (F1/F2/F3).
# The board must surface structural problems by name instead of silently
# deadlocking or skipping rows. RED until phase-graph.sh is hardened.
#
# Negative fixtures are staged under NEUTRAL slugs (badrow/missingdep/loop) so an
# asserted keyword can't match the slug the board echoes in its header.
load ../helpers/test_helper

@test "board: undefined dependency is flagged as 'undefined' (not just 'needs: 9')" {
  setup_docs bad-undefined-dep missingdep
  run pg missingdep
  assert_contains "$output" "undefined"
}

@test "board: a cycle is named, not the generic 'nothing ready'" {
  setup_docs bad-cycle loop
  run pg loop
  assert_contains "$output" "cycle"
}

@test "board: a malformed phase row is surfaced by its bad cell (2a)" {
  setup_docs bad-malformed-table badrow
  run pg badrow
  assert_contains "$output" "2a"
}

@test "--lint: clean plan exits 0" {
  setup_docs linear linear
  run pg linear --lint
  [ "$status" -eq 0 ]
}

@test "--lint: cycle exits non-zero and names the cycle" {
  setup_docs bad-cycle loop
  run pg loop --lint
  [ "$status" -ne 0 ]
  assert_contains "$output" "cycle"
}

@test "--lint: undefined dep exits non-zero and names the phase" {
  setup_docs bad-undefined-dep missingdep
  run pg missingdep --lint
  [ "$status" -ne 0 ]
  assert_contains "$output" "undefined"
}

@test "--lint: malformed cell exits non-zero and names it" {
  setup_docs bad-malformed-table badrow
  run pg badrow --lint
  [ "$status" -ne 0 ]
  assert_contains "$output" "2a"
}

@test "--lint: clean diamond and ranges pass" {
  setup_docs diamond diamond; run pg diamond --lint; [ "$status" -eq 0 ]
  setup_docs ranges ranges;   run pg ranges --lint;  [ "$status" -eq 0 ]
}

# --- engine-9 / engine-12: two arms that answered badly ----------------------

@test "diagnostics: --boot-prompt for a phase not in the plan says so" {
  # Every other per-phase arm supplies a `:-` default; this one indexed DEPS and
  # GATED bare, so an unknown phase died with `DEPS[$p]: unbound variable` and a
  # line number. The console shells this, so that is what the operator saw.
  setup_docs linear linear
  run pg linear --boot-prompt 99
  [ "$status" -eq 2 ]
  assert_contains "$output" "phase 99 is not in this plan"
  refute_contains "$output" "unbound variable"
}

@test "diagnostics: --boot-prompt accepts a zero-padded phase number" {
  setup_docs linear linear
  run pg linear --boot-prompt 02
  [ "$status" -eq 0 ]
  assert_contains "$output" "start Phase 2 in this fresh session"
}

@test "diagnostics: --ready and --memory-block answer DIFFERENT questions on a closed plan" {
  # engine-12 read the disagreement as a bug and asked for --memory-block to
  # empty its ready bucket on closure. It is not a bug. `--ready` answers "what
  # may I start now", and a closed plan starts nothing; --memory-block answers
  # "what IS the state of each phase" — a plan someone walked away from must
  # still be able to say what it never got to, and the `closed:` line is how a
  # reader tells the two apart. viewer/test/plan-closure.test.ts pins the other
  # half of this and spells out why every client surface gates it itself.
  setup_docs closed closed
  run pg closed --ready
  [ "$output" = "" ]
  run pg closed --memory-block
  [ "$status" -eq 0 ]
  assert_contains "$output" "closed: abandoned"
  assert_contains "$output" "ready: 1"
}
