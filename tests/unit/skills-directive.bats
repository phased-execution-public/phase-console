#!/usr/bin/env bats
# Skills directive (the plan's "## Session budget" `Skills (every session):` line) is
# re-injected into EVERY phase boot prompt and the QA brief, so a cold-start session
# re-invokes the skills the user named at plan time. A plan with no such line must emit
# nothing extra — and must not fail under `set -euo pipefail` (the no-match grep trap).
load ../helpers/test_helper

@test "boot-prompt: a plan's Skills directive is injected into the phase boot prompt" {
  setup_docs skilled skilled
  run pg skilled --boot-prompt 2
  [ "$status" -eq 0 ]
  assert_contains "$output" 'Before you start: Call the Skill tool with "design-system". Call the Skill tool with "some-plugin:test-first".'

}

@test "qa-prompt: the Skills directive is injected into the QA brief too" {
  setup_docs skilled skilled
  run pg skilled --qa-prompt 2
  [ "$status" -eq 0 ]
  assert_contains "$output" "design-system"
}

@test "boot-prompt: a plan with NO Skills directive emits no skills line and still succeeds" {
  setup_docs linear linear
  run pg linear --boot-prompt 2
  [ "$status" -eq 0 ]
  refute_contains "$output" "Call the Skill tool"
}

@test "boot-prompt: budget prose containing 'skill' + backticks is NOT read as a Skills directive" {
  # Regression (found by v3 smoke evals): a §Session budget line like
  # "**Budget:** per skill sizing defaults · `claude-opus-5`" used to be swallowed
  # by the loose 'skill' grep, injecting the model id as a skill to invoke.
  setup_docs linear linear
  printf '\n## Session budget\n**Target model:** `claude-opus-5` · **Budget:** ~200K weight/session (skill v3 sizing) · **Branch:** current\n' \
    >> "$DOCS_ROOT/docs/plans/linear.md"
  run pg linear --boot-prompt 2
  [ "$status" -eq 0 ]
  refute_contains "$output" "Call the Skill tool"
  refute_contains "$output" "claude-opus-5"
}

# measured-console phase 11: ONE line, a Skill-tool call by qualified name per
# skill, from the plan's line, the phase's `- **Skills:**` bullet (unioned) and
# the handoffs' suggested_skills; the adapter when a mattpocock skill is in it.
_bullet() {  # _bullet <phase> <line> — add a bullet under the phase's heading
  f="$DOCS_ROOT/docs/plans/skilled.md"
  awk -v h="### Phase $1 " -v l="$2" 'index($0, h) == 1 { print; print l; next } { print }' "$f" > "$f.t" && mv "$f.t" "$f"
}

@test "skills: a phase's Skills bullet is unioned with the plan's line, and --skills prints both" {
  setup_docs skilled skilled
  _bullet 2 '- **Skills:** `tdd`, `design-system`'
  [ "$(pg skilled --skills)" = "design-system, some-plugin:test-first" ]
  [ "$(pg skilled --skills 2)" = "design-system, some-plugin:test-first, tdd" ]
  [ "$(pg skilled --skills 1)" = "design-system, some-plugin:test-first" ]
  run pg skilled --boot-prompt 2
  assert_contains "$output" 'Call the Skill tool with "tdd".'
  [ "$(printf '%s\n' "$output" | grep -c 'Call the Skill tool')" -eq 1 ]
}

@test "skills: PE_SKILLS qualifies a bare name by its one plugin, and a mattpocock skill brings the adapter" {
  setup_docs skilled skilled
  _bullet 2 '- **Skills:** `tdd`'
  out="$(PE_SKILLS='phased-execution:phased-execution design-system some-plugin:test-first mattpocock-skills:tdd' pg skilled --boot-prompt 2)"
  assert_contains "$out" 'Call the Skill tool with "mattpocock-skills:tdd".'
  # Two plugins carrying the name: left as written — the Skill tool resolves a bare name itself.
  out="$(PE_SKILLS='a:tdd b:tdd design-system' pg skilled --boot-prompt 2)"
  assert_contains "$out" 'Call the Skill tool with "tdd".'
  refute_contains "$out" 'Unattended, these rule'
}

@test "skills: F47 names a skill the console's set lacks and one marked disable-model-invocation, and is silent by hand" {
  setup_docs skilled skilled
  _bullet 2 '- **Skills:** `grilling`, `tdd`'
  PE_SKILLS='design-system mattpocock-skills:tdd mattpocock-skills:grilling!' run pg skilled --lint
  [ "$status" -eq 0 ]
  assert_contains "$output" 'LINT OK'
  assert_contains "$output" 'F47 plan: skill-unresolved — `some-plugin:test-first`'
  assert_contains "$output" 'F47 phase 2: skill-user-invoked — `grilling` is marked disable-model-invocation'
  refute_contains "$output" '`tdd`'
  refute_contains "$output" '`design-system`'
  run pg skilled --lint
  [ "$status" -eq 0 ]
  refute_contains "$output" 'F47'
}
