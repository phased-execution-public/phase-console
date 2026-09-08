#!/usr/bin/env bats
# The `- **Setup:**` bullet, and the two advisories that send a plan towards it.
#
# F22 — bring-up inside §Verification. 19 hub plans wrote `docker compose up -d`
# there because the format had nowhere else to put it, and every such line is a
# command the boarding preflight asks a person to vouch for AND a line that can
# turn a phase red for a reason unrelated to its work (register R27).
#
# F23 — an expected failure stated in PROSE. "`task verify` — expected to fail
# until Phase 9" reads as passing to a person and as FAILING to the runner,
# which executes the command and takes its exit code.
#
# Both are ADVISORY: they ride stderr, they never move an exit code, and they
# never touch the LINT OK line.
load ../helpers/test_helper

@test "--setup: the plan-wide line and the phase's own bullet, plan first" {
  setup_docs setup-bullet setupb
  run pg setupb --setup 1
  [ "$status" -eq 0 ]
  # Ordered, because bring-up is ordered: the shared stack has to be up before
  # a phase's own step against it can work.
  [ "$(printf '%s\n' "$output" | sed -n 1p)" = "docker compose up -d" ]
  [ "$(printf '%s\n' "$output" | sed -n 2p)" = "sleep 8" ]
  [ "$(printf '%s\n' "$output" | sed -n 3p)" = "npm ci" ]
}

@test "--setup: a phase with no bullet of its own still gets the plan-wide preamble" {
  setup_docs setup-bullet setupb
  run pg setupb --setup 2
  [ "$status" -eq 0 ]
  assert_contains "$output" "docker compose up -d"
  [[ "$output" != *"npm ci"* ]]
}

@test "--setup: Setup does not swallow the Verification bullet that follows it" {
  setup_docs setup-bullet setupb
  run pg setupb --setup 1
  # The reach ends at the next top-level labelled bullet. Without that, the
  # first command bullet absorbs the second and F22 fires on every phase that
  # did exactly what F22 asks for.
  [[ "$output" != *"npm test"* ]]
}

@test "--setup: a phase number is required" {
  setup_docs setup-bullet setupb
  run pg setupb --setup
  [ "$status" -eq 2 ]
}

@test "F22: bring-up inside §Verification is named, exit stays 0" {
  setup_docs setup-bullet setupb
  run pg setupb --lint
  [ "$status" -eq 0 ]
  assert_contains "$output" "LINT OK"
  assert_contains "$output" "F22 phase 2"
  assert_contains "$output" "docker compose up"
}

@test "F22: a phase that puts its bring-up in Setup is not nagged" {
  setup_docs setup-bullet setupb
  run pg setupb --lint
  [[ "$output" != *"F22 phase 1"* ]]
}

@test "F22: a done phase is not nagged about history" {
  setup_docs setup-bullet setupb
  write_handoff setupb 2 bringup complete
  run pg setupb --lint
  [ "$status" -eq 0 ]
  [[ "$output" != *"F22 phase 2"* ]]
}

@test "F23: an expected failure stated in prose is named" {
  setup_docs setup-bullet setupb
  run pg setupb --lint
  [ "$status" -eq 0 ]
  assert_contains "$output" "F23 phase 3"
  assert_contains "$output" "exit codes, not sentences"
}

@test "F23: a phase whose verification simply passes says nothing" {
  setup_docs setup-bullet setupb
  run pg setupb --lint
  [[ "$output" != *"F23 phase 1"* ]]
  [[ "$output" != *"F23 phase 2"* ]]
}

@test "F16: a poll loop written across three fenced lines is still a poll loop" {
  setup_docs setup-bullet setupb
  run pg setupb --lint
  [ "$status" -eq 0 ]
  # The fold is the point: the shared alternation spells its spaces literally
  # (one string, two dialects), so a multi-line construct cannot match until it
  # is one line — and the runtime side folds too.
  assert_contains "$output" "F16 phase 4"
}

@test "F16: the carve-out — a DETACHED compose up is not a wait" {
  setup_docs setup-bullet setupb
  run pg setupb --lint
  # Phase 2 runs `docker compose up -d`, which returns. It earns an F22 (it is
  # bring-up) and must NOT earn an F16 (it is not a wait).
  [[ "$output" != *"F16 phase 2"* ]]
}

@test "F22/F23: validate.sh inherits both without failing" {
  setup_docs setup-bullet setupb
  run pe_validate setupb
  [ "$status" -eq 0 ]
  assert_contains "$output" "F22 phase 2"
  assert_contains "$output" "F23 phase 3"
  assert_contains "$output" "VALIDATE OK"
}

@test "--setup: a FENCED Setup block is commands, not silence (QA M6)" {
  setup_docs setup-bullet setupb
  run pg setupb --setup 5
  [ "$status" -eq 0 ]
  # `--setup` used to grep backtick spans only, so a fenced block printed
  # NOTHING and the boot prompt omitted "Bring the stack up first" entirely —
  # while the runner's own extractor ran the block. Two readers of one bullet
  # disagreeing about whether it exists.
  assert_contains "$output" "docker compose up -d"
  assert_contains "$output" "npm ci"
  # …and the plan-wide line still comes first.
  [ "$(printf '%s\n' "$output" | sed -n 1p)" = "docker compose up -d" ]
}

@test "--setup: a fenced block's comments and blanks are not commands" {
  setup_docs setup-bullet setupb
  run pg setupb --setup 5
  [[ "$output" != *"# the stack"* ]]
  [[ "$output" != *"npm test"* ]]
}

@test "F22: the message is a whole sentence" {
  setup_docs setup-bullet setupb
  run pg setupb --lint
  # It ended "…never marks the phase red for" — mid-sentence, in the one line
  # an author reads to decide whether to act on it.
  [[ "$output" != *"red for"* ]]
  assert_contains "$output" "can never mark the phase red"
}

@test "F22: a poll loop's pacing is not bring-up (QA L9)" {
  setup_docs setup-bullet setupb
  run pg setupb --lint
  # Unanchored, `sleep [0-9]` matched the `sleep 5` INSIDE phase 4's
  # `until …; do sleep 5; done` — telling an author to move a fragment of a
  # command into a Setup bullet. F22 now matches at a command HEAD only.
  [[ "$output" != *"F22 phase 4"* ]]
  # …while the real bring-up, at a head, still fires.
  assert_contains "$output" "F22 phase 2"
}
