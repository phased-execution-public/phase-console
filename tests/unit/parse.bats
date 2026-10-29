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

# --------------------------------------------------------------------------
# §Session budget directives that share a line (measured-console phase 2, #419)
# --------------------------------------------------------------------------

@test "§Session budget: every directive after ' · ' is read — verify timeout, wait count, gitlink, issues, messaging" {
  setup_docs directive-mid-line directive-mid-line
  run pg directive-mid-line --verify-timeout 1
  [ "$output" = "$(printf '90\tplan')" ]
  run pg directive-mid-line --wait-count 1
  [ "$output" = "$(printf '8\tplan')" ]
  run pg directive-mid-line --wait-budget 1
  [ "$output" = "$(printf '480\tplan')" ]
  run pg directive-mid-line --gitlink 1
  [ "$output" = "$(printf 'leave\tplan')" ]
  run pg directive-mid-line --issues 1
  [ "$output" = "$(printf 'draft\tplan')" ]
  run pg directive-mid-line --messaging
  [ "$output" = "$(printf 'off\tplan')" ]
  # a phase's own bullet still wins
  run pg directive-mid-line --verify-timeout 3
  [ "$output" = "$(printf '30\tphase')" ]
}

@test "§Session budget: the first directive of a shared line keeps its value — a target model before ' · **Budget:**'" {
  setup_docs directive-mid-line directive-mid-line
  run pg directive-mid-line --model
  [ "$output" = "claude-opus-5" ]
}

# --------------------------------------------------------------------------
# The three bullets measured-console phase 6 adds: `Subagent model:` (a plan
# line and a phase bullet over it), `Fast gate:` and `May delete tests:` (a
# phase bullet only, each with a default of its own).
# --------------------------------------------------------------------------

@test "--subagent-model: the plan's quoted line, a phase's bullet over it, its first word only" {
  setup_docs subagent-model subagent-model
  run pg subagent-model --subagent-model
  [ "$status" -eq 0 ]
  [ "$output" = "$(printf 'claude-sonnet-5-5\tplan')" ]
  run pg subagent-model --subagent-model 1
  [ "$output" = "$(printf 'claude-sonnet-5-5\tplan')" ]
  run pg subagent-model --subagent-model 2
  [ "$output" = "$(printf 'claude-haiku-4-5\tphase')" ]
  # a bullet naming nothing falls through to the plan's line
  run pg subagent-model --subagent-model 3
  [ "$output" = "$(printf 'claude-sonnet-5-5\tplan')" ]
  # bold and backticks stripped, the [1m] suffix kept, the prose after it dropped
  run pg subagent-model --subagent-model 4
  [ "$output" = "$(printf 'claude-opus-5-5[1m]\tphase')" ]
}

@test "--subagent-model: a plan that never says answers NOTHING — the session decides" {
  setup_docs model-policy model-policy
  run pg model-policy --subagent-model 1
  [ "$status" -eq 0 ]
  [ -z "$output" ]
  run pg model-policy --subagent-model
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "--fast-gate N: the phase's word, else on from the default — a typo is silence" {
  setup_docs subagent-model subagent-model
  run pg subagent-model --fast-gate 1
  [ "$status" -eq 0 ]
  [ "$output" = "$(printf 'on\tdefault')" ]
  run pg subagent-model --fast-gate 2
  [ "$output" = "$(printf 'off\tphase')" ]
  run pg subagent-model --fast-gate 3
  [ "$output" = "$(printf 'on\tdefault')" ]
  run pg subagent-model --fast-gate 4
  [ "$output" = "$(printf 'off\tphase')" ]
  run pg subagent-model --fast-gate 5
  [ "$output" = "$(printf 'on\tphase')" ]
}

@test "--may-delete-tests N: the phase's word, else no from the default — a typo is silence" {
  setup_docs subagent-model subagent-model
  run pg subagent-model --may-delete-tests 1
  [ "$status" -eq 0 ]
  [ "$output" = "$(printf 'no\tdefault')" ]
  run pg subagent-model --may-delete-tests 2
  [ "$output" = "$(printf 'yes\tphase')" ]
  run pg subagent-model --may-delete-tests 3
  [ "$output" = "$(printf 'no\tdefault')" ]
  run pg subagent-model --may-delete-tests 4
  [ "$output" = "$(printf 'yes\tphase')" ]
  run pg subagent-model --may-delete-tests 5
  [ "$output" = "$(printf 'no\tphase')" ]
}

@test "--subagent-model, --fast-gate, --may-delete-tests: an unknown phase is a usage error; the two phase-only modes need N" {
  setup_docs subagent-model subagent-model
  for mode in --subagent-model --fast-gate --may-delete-tests; do
    run pg subagent-model "$mode" 9
    [ "$status" -eq 2 ]
    assert_contains "$output" "phase 9 is not in this plan"
  done
  for mode in --fast-gate --may-delete-tests; do
    run pg subagent-model "$mode"
    [ "$status" -eq 2 ]
    assert_contains "$output" "usage: phase-graph.sh <slug> $mode N"
  done
}

@test "the three new labels are F50-anchored: written mid-line, the lint names them" {
  setup_docs subagent-model subagent-model
  run pg subagent-model --lint
  [ "$status" -eq 0 ]
  [[ "$output" != *"F50"* ]]
  plan="$DOCS_ROOT/docs/plans/subagent-model.md"
  sed -e 's/^- \*\*Size:\*\* S$/- **Size:** S · **Fast gate:** off · **May delete tests:** yes · **Subagent model:** x/' \
    -e 's/^A sentence here that says the subagent model/A sentence, **Subagent model:** y, that says the subagent model/' \
    "$plan" > "$plan.new" && mv "$plan.new" "$plan"
  run pg subagent-model --lint
  assert_contains "$output" 'F50 phase 1: directive-mid-line — `**Fast gate:**` sits mid-line in a bullet'
  assert_contains "$output" 'F50 phase 1: directive-mid-line — `**May delete tests:**` sits mid-line in a bullet'
  assert_contains "$output" 'F50 phase 1: directive-mid-line — `**Subagent model:**` sits mid-line in a bullet'
  assert_contains "$output" 'F50 §Session budget: directive-mid-line — `**Subagent model:**` sits mid-line'
}
