#!/usr/bin/env bats
# The boot prompt, slimmed (measured-console phase 2): relative paths, the
# phase read through `--section N`, and only the decision rows a session must
# not discover mid-phase.
load ../helpers/test_helper

@test "boot-prompt: under \$HOME the paths are written \$HOME-relative — no absolute path of the account" {
  setup_docs decisions decisions
  run env HOME="$BATS_TEST_TMPDIR" DOCS_ROOT="$DOCS_ROOT" "$SYS_BASH" "$PE_SCRIPTS/phase-graph.sh" decisions --boot-prompt 1
  [ "$status" -eq 0 ]
  refute_contains "$output" "$BATS_TEST_TMPDIR/"
  assert_contains "$output" 'DOCS_ROOT=$HOME/work bash'
}

@test "boot-prompt: outside \$HOME the root and the scripts stay absolute — a paste still lands here" {
  setup_docs decisions decisions
  run env HOME=/nonexistent-home DOCS_ROOT="$DOCS_ROOT" "$SYS_BASH" "$PE_SCRIPTS/phase-graph.sh" decisions --boot-prompt 1
  assert_contains "$output" "DOCS_ROOT=$DOCS_ROOT bash \"\${PE_SCRIPTS:-$PE_SCRIPTS}\""
}

@test "boot-prompt: the plan is read through --section N, never whole" {
  setup_docs decisions decisions
  run pg decisions --boot-prompt 2
  assert_contains "$output" "phase-graph.sh decisions --section 2"
  refute_contains "$output" "§Phase 2 + §Session budget"
}

@test "boot-prompt: no answered decision row, and the line that reads them" {
  setup_docs decisions decisions
  run pg decisions --boot-prompt 3
  refute_contains "$output" "[answered]"
  assert_contains "$output" "phase-graph.sh decisions --decisions 3"
}

# --- PE_BRIEF=hook (measured-console phase 4) -------------------------------------
# With the presence hook briefing the session, the prompt leaves out what the
# brief carries — the decisions, the notes, the scope and lock lines — and says
# where they went; without it the prompt is what it always was.

note_for_phase_2() {
  write_handoff decisions 1 alpha complete
  f="$DOCS_ROOT/docs/handoffs/decisions/phase-01-alpha.md"
  printf '\n## What this phase did\nShipped.\n\n## Notes for later phases\n- **Phase 2:** the fixture dir moved to fixtures/next.\n' >> "$f"
}

@test "boot-prompt: under PE_BRIEF=hook the decisions, the notes and the lock lines leave the prompt" {
  setup_docs decisions decisions
  note_for_phase_2
  full="$(pg decisions --boot-prompt 2)"
  hook="$(PE_BRIEF=hook pg decisions --boot-prompt 2)"
  assert_contains "$full" 'Notes from earlier phases (1)'
  assert_contains "$full" "This phase's DECISIONS"
  assert_contains "$full" 'conflicts 2 --scope'
  refute_contains "$hook" 'Notes from earlier phases'
  refute_contains "$hook" "This phase's DECISIONS"
  refute_contains "$hook" 'conflicts 2 --scope'
  assert_contains "$hook" 'phase-graph.sh decisions --brief 2'
  # what a session works from stays: the wait procedure, the tasks, the handoff
  assert_contains "$hook" 'Waiting without polling.'
  assert_contains "$hook" 'phase-tasks.sh decisions 2 reset'
  assert_contains "$hook" 'new-handoff.sh decisions 2'
  [ "${#hook}" -lt "${#full}" ]
}

@test "brief: --brief N carries what the hook-trimmed prompt left out, within its byte cap" {
  setup_docs decisions decisions
  note_for_phase_2
  run pg decisions --brief 2
  [ "$status" -eq 0 ]
  assert_contains "$(printf '%s\n' "$output" | head -1)" 'references/mode-phase-start.md'
  assert_contains "$output" '### Phase 2'
  assert_contains "$output" '## Decisions still open'
  assert_contains "$output" 'the fixture dir moved to fixtures/next.'
  assert_contains "$output" '## Scope and lock'
  assert_contains "$output" '## Phase 1 handed you (docs/handoffs/decisions/phase-01-alpha.md)'
  assert_contains "$output" 'Shipped.'
  [ "$(pg decisions --brief 2 | wc -c)" -le 10000 ]
  small="$(PE_BRIEF_MAX=400 pg decisions --brief 2)"
  [ "$(printf '%s\n' "$small" | wc -c)" -le 400 ]
  assert_contains "$small" 'the brief stops here at 400 bytes'
  run pg decisions --brief 99
  [ "$status" -eq 2 ]
}

@test "boot-prompt and brief: a dependency handoff's suggested_skills become the Skill-tool line" {
  setup_docs decisions decisions
  write_handoff decisions 1 alpha complete
  f="$DOCS_ROOT/docs/handoffs/decisions/phase-01-alpha.md"
  awk 'NR == 5 { print; print "suggested_skills: [mattpocock-skills:tdd, `dataviz`]   # for phase 2"; next } { print }' "$f" > "$f.t" && mv "$f.t" "$f"
  printf '\n## What this phase did\nShipped.\n' >> "$f"
  line='Before you start: Call the Skill tool with "mattpocock-skills:tdd". Call the Skill tool with "dataviz".'
  assert_contains "$(pg decisions --boot-prompt 2)" "$line"
  assert_contains "$(pg decisions --brief 2)" "$line"
  refute_contains "$(pg decisions --boot-prompt 1)" 'Call the Skill tool'
}
