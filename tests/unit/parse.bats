#!/usr/bin/env bats
# Phase-graph table parsing: dependency grammar (ranges, commas, dashes, bold).
# These lock in correct CURRENT behavior — they must stay green through the refactor.
load ../helpers/test_helper

@test "linear: deps are parsed in chain order" {
  setup_docs linear linear
  run pg linear --deps 2; [ "$output" = "1" ]
  run pg linear --deps 3; [ "$output" = "2" ]
  run pg linear --deps 1; [ "$output" = "" ]
}

@test "diamond: comma list yields both parents" {
  setup_docs diamond diamond
  run pg diamond --deps 4
  [ "$status" -eq 0 ]
  [ "$output" = "2 3" ]
}

@test "diamond: dependents of root are 2 and 3" {
  setup_docs diamond diamond
  run pg diamond --dependents 1
  [ "$output" = "2 3" ]
}

@test "ranges: en-dash range 1–2 expands to 1 2" {
  setup_docs ranges ranges
  run pg ranges --deps 3
  [ "$output" = "1 2" ]
}

@test "ranges: comma list 1, 2, 3 parses" {
  setup_docs ranges ranges
  run pg ranges --deps 4
  [ "$output" = "1 2 3" ]
}

@test "ranges: em-dash range 2—4 expands to 2 3 4" {
  setup_docs ranges ranges
  run pg ranges --deps 5
  [ "$output" = "2 3 4" ]
}

@test "ranges: combo 1–2 (+4) expands to 1 2 4" {
  setup_docs ranges ranges
  run pg ranges --deps 6
  [ "$output" = "1 2 4" ]
}

@test "ranges: markdown-bold phase cell (**5**) is still parsed as phase 5" {
  setup_docs ranges ranges
  # If **5** were skipped, --dependents 4 would not include 5 (5 depends on 2-4).
  run pg ranges --dependents 4
  assert_contains "$output" "5"
}

@test "the row parser emits four fields without disturbing deps or titles" {
  # The Repos column joined the parsed row after deps and titles were already
  # load-bearing. A shifted field would corrupt the graph silently, so this
  # asserts the older two still read correctly on a plan that fills all of them.
  setup_docs scoped scoped
  run pg scoped --deps 4;  [ "$output" = "1" ]
  run pg scoped --deps 1;  [ "$output" = "" ]
  run pg scoped --dependents 1; [ "$output" = "2 3 4 5 6 7" ]
  run pg scoped --repos 2; [ "$output" = "api-server" ]
  run pg scoped; assert_contains "$output" "Packages"
}

@test "an empty Repos cell does not shift the columns beside it" {
  # Phase 5's Repos cell is a lone dash; deps, size and title must survive it.
  setup_docs scoped scoped
  run pg scoped --deps 5;  [ "$output" = "1" ]
  run pg scoped --size 5;  [ "$output" = "S" ]
  run pg scoped --repos 5; [ "$output" = "all" ]
  run pg scoped; assert_contains "$output" "Anything"
}

# --- Credentials and accounts (zero-touch-console phase 3, ZTD-4) ------------
# `--credentials [N]` composes like `--mcp` (plan line ∪ phase bullet, deduped,
# first-seen order); `--credential-policy [N]` like `--mcp-policy` (the phase
# overrides, only `require`/`continue` count, silence prints nothing);
# `--accounts` reads `**Accounts:**` as id:minHeadroom pairs, one per line.

@test "--credentials: the plan-wide line alone, decoy prose ignored" {
  setup_docs credentials credentials
  run pg credentials --credentials
  [ "$status" -eq 0 ]
  [ "$output" = "gh, claude-login" ]
}

@test "--credentials N: plan line ∪ phase bullet, deduped, first-seen order" {
  setup_docs credentials credentials
  run pg credentials --credentials 1;  [ "$output" = "gh, claude-login" ]
  run pg credentials --credentials 2;  [ "$output" = "gh, claude-login, npm-token" ]
  run pg credentials --credentials 4;  [ "$output" = "gh, claude-login" ]
}

@test "--credentials: a plan that names none prints an empty line" {
  setup_docs linear linear
  run pg linear --credentials 1
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "--credential-policy: plan-wide, inherited, carved out, and a typo is silence" {
  setup_docs credentials credentials
  run pg credentials --credential-policy;    [ "$output" = "require" ]
  run pg credentials --credential-policy 1;  [ "$output" = "require" ]
  run pg credentials --credential-policy 3;  [ "$output" = "continue" ]
  run pg credentials --credential-policy 4;  [ "$output" = "require" ]
  setup_docs linear linear
  run pg linear --credential-policy 1
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "--accounts: id<TAB>minHeadroom per line, min empty when the pair carries none" {
  setup_docs credentials credentials
  run pg credentials --accounts
  [ "$status" -eq 0 ]
  [ "$output" = "$(printf 'default\t20\nwork\t10\nspare\t')" ]
  setup_docs linear linear
  run pg linear --accounts
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "F15: a credential or account the console does not hold is advisory — LINT OK stays" {
  setup_docs credentials credentials
  PE_CREDENTIALS="gh" PE_ACCOUNTS="default" run pg credentials --lint
  [ "$status" -eq 0 ]
  assert_contains "$output" "LINT OK"
  assert_contains "$output" "F15 plan: credential(s) the console does not hold: claude-login"
  assert_contains "$output" "F15 phase 2: credential(s) the console does not hold: npm-token"
  assert_contains "$output" 'F15 plan: account `work` is not registered'
  assert_contains "$output" 'F15 plan: account `spare` is not registered'
  # unset = no console here: silent
  run pg credentials --lint
  [[ "$output" != *"F15"* ]]
}
