#!/usr/bin/env bats
# A lint that proved nothing stops nothing.
#
# `--lint`'s advisory pass walked each phase's §Verification span by span
# through a `while read` fed by a process substitution NESTED inside another
# one. On macOS `/bin/bash` 3.2 that corrupted the allocator: a 36-phase plan
# died mid-pass with nothing on stdout, nothing on stderr and an exit code in
# the signal range — and every reader above took the silence for a verdict.
# Only bats proves any of this, because only bats forces /bin/bash.
#
# Three properties, and the third is the one that matters to a plan author:
# the span pass survives repetition; an advisory family that dies cannot move
# the exit code, because an advisory never could; and a validator whose engine
# died says so instead of handing on a bare code nobody can read.
load ../helpers/test_helper

@test "F17 span loop survives 25 runs" {
  setup_docs lint-f17-spans lfs
  i=0
  while [ "$i" -lt 25 ]; do
    run pg lfs --lint
    [ "$status" -eq 0 ] || {
      echo "run $i exited $status" >&2
      echo "$output" >&2
      false
    }
    assert_contains "$output" "LINT OK: lfs — 36 phases"
    i=$((i + 1))
  done
}

@test "a crashed advisory never gates" {
  setup_docs lint-f17-spans lfs
  PE_LINT_FAULT=F17 run pg lfs --lint
  [ "$status" -eq 0 ]
  assert_contains "$output" "LINT OK: lfs — 36 phases"
  assert_contains "$output" "F17 could not run (exit 133) — this advisory proved nothing"
  # ONE line, not one per phase: the family is guarded as a whole.
  [ "$(printf '%s\n' "$output" | grep -c 'could not run (exit')" -eq 1 ]
}

@test "a crashed advisory leaves every other advisory speaking" {
  # `missing-lead` is the fixture that trips BOTH lead checks: phase 2 names a
  # binary nothing has, phase 4 runs a cwd-sensitive one with no Verify in.
  setup_docs missing-lead ml
  PE_LINT_FAULT=F17 run pg ml --lint
  [ "$status" -eq 0 ]
  assert_contains "$output" "F17 could not run (exit 133)"
  [[ "$output" != *"F17 phase 2"* ]]
  # F18 rides the same arm, reads the same span pass, and is not the one that died.
  assert_contains "$output" "F18 phase 4"
}

@test "a crashed advisory cannot rescue a plan with real issues" {
  setup_docs bad-undefined-dep bud
  PE_LINT_FAULT=F17 run pg bud --lint
  [ "$status" -eq 1 ]
  assert_contains "$output" "LINT FAIL"
}

@test "validate.sh names an engine crash and exits 70" {
  setup_docs lint-f17-spans lfs
  PE_LINT_FAULT=engine run pe_validate lfs
  [ "$status" -eq 70 ]
  assert_contains "$output" "the engine's lint crashed (signal 5)"
  assert_contains "$output" "run it under bash 5 or report the plan"
}

@test "validate.sh still fails a genuinely broken plan with 1" {
  setup_docs bad-undefined-dep bud
  run pe_validate bud
  [ "$status" -eq 1 ]
  assert_contains "$output" "LINT FAIL"
}

@test "validate.sh still passes a clean plan" {
  setup_docs lint-f17-spans lfs
  run pe_validate lfs
  [ "$status" -eq 0 ]
  assert_contains "$output" "VALIDATE OK: lfs"
}
