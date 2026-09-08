#!/usr/bin/env bats
# F14 — a phase without a runnable §Verification warns at lint time, never gates.
# The advisory exists because the autopilot parks such a phase at boarding
# ("nothing would prove the work"), hours after plan time; the author should
# hear it while the plan is still in front of them. Warning tier by design:
# exit codes and the LINT OK line never move.
load ../helpers/test_helper

@test "F14: an open phase with no Verification bullet is named, exit stays 0" {
  setup_docs nested-verification nestedv
  run pg nestedv --lint
  [ "$status" -eq 0 ]
  assert_contains "$output" "LINT OK"
  assert_contains "$output" "F14 phase 3"
}

@test "F14: nested sub-bullet verification counts as runnable" {
  setup_docs nested-verification nestedv
  run pg nestedv --lint
  [[ "$output" != *"F14 phase 1"* ]]
  [[ "$output" != *"F14 phase 2"* ]]
}

@test "F14: a done phase is not nagged about history" {
  setup_docs nested-verification nestedv
  write_handoff nestedv 3 bare complete
  run pg nestedv --lint
  [ "$status" -eq 0 ]
  [[ "$output" != *"F14"* ]]
}

@test "F14: a plan whose every phase verifies stays silent" {
  setup_docs scoped scoped
  run pg scoped --lint
  [ "$status" -eq 0 ]
  [[ "$output" != *"F14"* ]]
}

@test "F14: validate.sh inherits the advisory without failing" {
  setup_docs nested-verification nestedv
  run pe_validate nestedv
  [ "$status" -eq 0 ]
  assert_contains "$output" "F14 phase 3"
  assert_contains "$output" "VALIDATE OK"
}

@test "F14: a closed plan is not scanned" {
  setup_docs closed closedp
  run pg closedp --lint
  [ "$status" -eq 0 ]
  [[ "$output" != *"F14"* ]]
}

# F16 — a §Verification that waits on an external clock warns at lint time,
# never gates. F14 asks "is anything runnable?"; F16 asks "does what runs ever
# finish on its own?". The live incident: a phase whose verification WAS the
# deploy of a CI-built image (34-65 min build) passed F14, boarded, and the
# session died holding the wait.

@test "F16: a fenced 'gh run watch' and a bulleted 'task deploy' are named, exit stays 0" {
  setup_docs unbounded-verification unb
  run pg unb --lint
  [ "$status" -eq 0 ]
  assert_contains "$output" "LINT OK"
  assert_contains "$output" "F16 phase 2"
  assert_contains "$output" "gh run watch"
  assert_contains "$output" "F16 phase 3"
  assert_contains "$output" "task deploy"
}

@test "F16: a bounded verification stays silent" {
  setup_docs unbounded-verification unb
  run pg unb --lint
  [[ "$output" != *"F16 phase 1"* ]]
}

@test "F16: runnable-but-unbounded does not trip F14" {
  setup_docs unbounded-verification unb
  run pg unb --lint
  [[ "$output" != *"F14"* ]]
}

@test "F16: a done phase is not nagged about history" {
  setup_docs unbounded-verification unb
  write_handoff unb 2 watch complete
  write_handoff unb 3 deploy complete
  run pg unb --lint
  [ "$status" -eq 0 ]
  [[ "$output" != *"F16"* ]]
}

# F16's vocabulary is not its own. It is EXTERNAL_WAIT in scripts/verify.env,
# shared with the console's runtime detector (viewer/server/runner/liveness.ts)
# so that what the lint warns about at plan time is what gets parked at run
# time. These two pin the seam from the bash side; the JS side is pinned by
# viewer/test/verify-env.test.ts, which runs BOTH engines over the same inputs.

@test "F16: the vocabulary is EXTERNAL_WAIT from scripts/verify.env, not a local copy" {
  run "$SYS_BASH" -c '. "$1/verify.env"; printf "%s" "$EXTERNAL_WAIT"' _ "$PE_SCRIPTS"
  [ "$status" -eq 0 ]
  assert_contains "$output" "gh run watch"
  assert_contains "$output" "task deploy"
  # The dialect-neutrality contract: one string drives a POSIX ERE here and a
  # JS RegExp in the runner, so a POSIX character class would break the half
  # that cannot be seen from bash.
  [[ "$output" != *"[:"* ]]
}

@test "F16: a tab-indented external wait is still caught (whitespace is normalised)" {
  # The shared vocabulary spells the space before `--watch` literally, because
  # JS has no `[[:space:]]`. That is only equivalent if the bash side
  # normalises tabs first — which is exactly the sort of claim that rots.
  setup_docs unbounded-verification unb
  # Phase 1 is the fixture's BOUNDED phase (test 8 pins that it stays silent),
  # so a hit here can only have come from the tab.
  # `task ci<TAB>--watch` is reachable ONLY through the ` --watch` alternative:
  # it is not `task deploy`, and it carries no `gh pr checks` prefix whose own
  # `[^\`]*` span would swallow the tab and pass for the wrong reason.
  local plan="$DOCS_ROOT/docs/plans/unb.md"
  "$SYS_BASH" -c 'printf "%s\n" "$(sed "s|^  - .npm test.$|  - \`task ci\t--watch\`|" "$1")" > "$1"' _ "$plan"
  grep -q "$(printf 'task ci\t--watch')" "$plan" || fail "the fixture edit did not land a tab"
  run pg unb --lint
  [ "$status" -eq 0 ]
  assert_contains "$output" "F16 phase 1"
}
