#!/usr/bin/env bats
# F36 `wait-window-short` (control-tower phase 14, #40): a `Waits on:` maximum
# shorter than the timeout of the workflow it watches can never outlast what it
# waits on. Phase 19 declared `· 60m` against a job whose own timeout was 100
# minutes, and the budget spent itself while the build ran on, healthy.
#
# The timeout is GitHub's, and bash 3.2 does not ask GitHub on every lint, so
# the console TELLS it — `PE_WAIT_TIMEOUTS`, whitespace-separated
# `<ref>=<minutes>` pairs, resolved once per run id (`watch-refs.ts`). The same
# told-not-asked rule as F15: unset means no console here and disables the
# check; set but empty is an answer (the console knows no timeout). ADVISORY:
# stderr only, the exit code never moves, done phases are not nagged.
load ../helpers/test_helper

@test "F36: a Waits on max below the told workflow timeout is named, with both numbers and the ref" {
  setup_docs waits waits
  PE_WAIT_TIMEOUTS='gh:acme/app#run/42=100' run pg waits --lint
  [ "$status" -eq 0 ]
  assert_contains "$output" "LINT OK"
  assert_contains "$output" 'F36 phase 2: wait-window-short — `Waits on:` allows 45m, but `gh:acme/app#run/42` may run 100m before its workflow times out'
}

@test "F36: a max at or above the timeout, or a ref with no told timeout, is silent" {
  setup_docs waits waits
  PE_WAIT_TIMEOUTS='gh:acme/app#run/42=45 gh:acme/app#run/99=5000' run pg waits --lint
  [ "$status" -eq 0 ]
  refute_contains "$output" "F36"
}

@test "F36: a bullet with no max is held to the plan's Wait budget it inherits" {
  setup_docs waits waits
  PE_WAIT_TIMEOUTS='gh:acme/app#run/43=900' run pg waits --lint
  [ "$status" -eq 0 ]
  assert_contains "$output" 'F36 phase 5: wait-window-short — `Waits on:` allows 720m, but `gh:acme/app#run/43` may run 900m before its workflow times out'
}

@test "F36: unset disables it; set but empty is an answer and says nothing" {
  setup_docs waits waits
  run pg waits --lint
  [ "$status" -eq 0 ]
  refute_contains "$output" "F36"
  PE_WAIT_TIMEOUTS='' run pg waits --lint
  [ "$status" -eq 0 ]
  refute_contains "$output" "F36"
  refute_contains "$output" "could not run"
  assert_contains "$output" "LINT OK"
}

@test "F36: a malformed pair is ignored rather than guessed at" {
  setup_docs waits waits
  PE_WAIT_TIMEOUTS='gh:acme/app#run/42=soon gh:acme/app#run/42 =100' run pg waits --lint
  [ "$status" -eq 0 ]
  refute_contains "$output" "F36"
}

@test "F36: a done phase is not nagged" {
  setup_docs waits waits
  write_handoff waits 2 two complete
  PE_WAIT_TIMEOUTS='gh:acme/app#run/42=100' run pg waits --lint
  [ "$status" -eq 0 ]
  refute_contains "$output" "F36 phase 2"
}
