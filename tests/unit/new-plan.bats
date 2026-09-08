#!/usr/bin/env bats
# coverage-15 — scripts/new-plan.sh and templates/ were exercised by zero tests.
# templates/plan.md is the seed of every plan the skill produces: if the engine
# cannot read what the template writes, every plan starts broken and the first
# person to notice is a session that has already been booted on it.
load ../helpers/test_helper

setup() {
  scrub_pe_env
  export DOCS_ROOT="$BATS_TEST_TMPDIR/work"
  mkdir -p "$DOCS_ROOT/docs/plans" "$DOCS_ROOT/docs/handoffs"
}

@test "new-plan: scaffolds the plan and substitutes every token" {
  run pe_newplan myplan
  [ "$status" -eq 0 ]
  [ -f "$DOCS_ROOT/docs/plans/myplan.md" ]
  # No residual {{...}} anywhere — an unsubstituted token ships into a real plan
  # and reads as content.
  run grep -n '{{' "$DOCS_ROOT/docs/plans/myplan.md"
  [ "$status" -eq 1 ]
  assert_contains "$(cat "$DOCS_ROOT/docs/plans/myplan.md")" "slug: myplan"
  assert_contains "$(cat "$DOCS_ROOT/docs/plans/myplan.md")" "memory: project_myplan"
}

@test "new-plan: the freshly scaffolded plan lints clean" {
  # The template ships `phases: TODO` and a two-row table. If the engine cannot
  # parse its own template, the very first `--lint` an author runs is red for a
  # plan they have not touched yet.
  pe_newplan myplan
  run pg myplan --lint
  [ "$status" -eq 0 ]
  assert_contains "$output" "2 phases"
}

@test "new-plan: validate.sh accepts the freshly scaffolded plan" {
  pe_newplan myplan
  run pe_validate myplan
  [ "$status" -eq 0 ]
}

@test "new-plan: the template's own table parses — deps, scope and readiness" {
  pe_newplan myplan
  run pg myplan --deps 2;  [ "$output" = "1" ]
  run pg myplan --deps 1;  [ "$output" = "" ]
  run pg myplan --ready;   [ "$output" = "1" ]
  # `Repos: TODO` is a placeholder, but it is a DECLARED one — it must not read
  # as `all`, or a template-fresh plan silently serializes everything.
  run pg myplan --repos 1; [ "$output" = "todo" ]
}

@test "new-plan: the template's Size tags are read from the phase blocks" {
  pe_newplan myplan
  run pg myplan --size 1; [ "$output" = "M" ]
  run pg myplan --size 2; [ "$output" = "M" ]
}

@test "new-plan: refuses to overwrite an existing plan" {
  pe_newplan myplan
  printf 'hand-edited\n' >> "$DOCS_ROOT/docs/plans/myplan.md"
  run pe_newplan myplan
  [ "$status" -eq 1 ]
  assert_contains "$output" "refusing to overwrite"
  assert_contains "$(cat "$DOCS_ROOT/docs/plans/myplan.md")" "hand-edited"
}

@test "new-plan: fails with a message when there is no docs/ to scaffold into" {
  export DOCS_ROOT="$BATS_TEST_TMPDIR/nodocs"
  mkdir -p "$DOCS_ROOT"
  run pe_newplan myplan
  [ "$status" -eq 1 ]
  assert_contains "$output" "docs/ not found"
}

@test "new-plan: the template declares QA off by default" {
  # QA is opt-in. A template that turned gating on by accident would make every
  # new plan hold its own dependents behind verdicts nobody was asked for.
  pe_newplan myplan
  run pg myplan --qa-mode
  [ "$status" -eq 0 ]
  assert_contains "$output" "off"
}
