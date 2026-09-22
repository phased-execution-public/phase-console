#!/usr/bin/env bats
#
# `new-handoff.sh` — the scaffold a phase-finish fills in.
#
# It is the one script whose OUTPUT is a document a person writes into, so the
# things worth pinning are the ones a person cannot repair by hand without
# knowing the rules: the frontmatter the engine reads back, the sections the
# body validator requires, and — since 5.1.0 — the `## Notes for later phases`
# section, which is the only channel that reaches a phase that has not started.
# A scaffold that quietly stopped emitting it would cost nothing today and
# every forward note from then on.
#
# The generated boot prompts are `phase-graph.sh --boot-prompt`'s and are
# covered where that lives; what is asserted here is that they are SPLICED —
# a handoff whose paste block is the literal `{{NEXT_PROMPTS}}` placeholder is
# the failure this script exists to prevent.

load ../helpers/test_helper

setup() {
  scrub_pe_env
  export DOCS_ROOT="$BATS_TEST_TMPDIR/work"
  mkdir -p "$DOCS_ROOT/docs/plans"
  cp "$PE_DIR/tests/fixtures/plans/diamond.md" "$DOCS_ROOT/docs/plans/demo.md"
}

handoff() { cat "$DOCS_ROOT/docs/handoffs/demo/$1"; }

@test "new-handoff: scaffolds the file, fills the frontmatter and appends the INDEX row" {
  run pe_newho demo 4 merge complete
  [ "$status" -eq 0 ]
  assert_contains "$output" "created"
  assert_contains "$output" "updated"

  local body; body="$(handoff phase-04-merge.md)"
  assert_contains "$body" "plan: docs/plans/demo.md"
  assert_contains "$body" "phase: 4"
  assert_contains "$body" "title: merge"
  assert_contains "$body" "status: complete"
  # `depends_on` and `blocks` come from the GRAPH, never from the phase number:
  # phase 4 of the diamond depends on 2 and 3 and blocks nothing.
  assert_contains "$body" "depends_on: [2, 3]"
  assert_contains "$body" "blocks: []"
  assert_contains "$body" "memory: project_diamond"
  # Nothing may survive unsubstituted — a `{{…}}` in a committed handoff is a
  # template leak nobody notices until a reader meets it.
  refute_contains "$body" "{{"

  assert_contains "$(cat "$DOCS_ROOT/docs/handoffs/demo/INDEX.md")" "phase-04-merge.md"
}

@test "new-handoff: every body section the validator requires is present, in order" {
  pe_newho demo 1 root complete >/dev/null
  local body; body="$(handoff phase-01-root.md)"
  for section in \
    "## What this phase did" \
    "## State now (verified)" \
    "## Files changed" \
    "## Key decisions / gotchas" \
    "## Notes for later phases" \
    "## ▶ Start next phase(s)" \
    "## Outstanding / blockers"; do
    assert_contains "$body" "$section"
  done
  run pe_validate demo
  [ "$status" -eq 0 ]
  assert_contains "$output" "VALIDATE OK"
}

@test "new-handoff: the notes section teaches all three addresses, because two are new" {
  pe_newho demo 1 root complete >/dev/null
  local body; body="$(handoff phase-01-root.md)"
  # The scaffold's comment is where a session learns the grammar — it is read
  # at the moment of writing, which no reference file is.
  assert_contains "$body" "- **Phase 7:**"
  assert_contains "$body" "- **Next:**"
  assert_contains "$body" "- **All:**"
  assert_contains "$body" "--notes"
  assert_contains "$body" "F26"
  # And the empty section is collected as nothing at all, not as a stray note.
  run pg demo --notes 2
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "new-handoff: a note written into the scaffolded section is collected by --notes" {
  pe_newho demo 1 root complete >/dev/null
  # Written the way a finishing session writes it: appended under the heading.
  awk '
    /^## Notes for later phases/ { print; print ""; print "- **Phase 2:** the parser is the left half'"'"'s."; next }
    { print }
  ' "$DOCS_ROOT/docs/handoffs/demo/phase-01-root.md" > "$BATS_TEST_TMPDIR/h" \
    && mv "$BATS_TEST_TMPDIR/h" "$DOCS_ROOT/docs/handoffs/demo/phase-01-root.md"

  run pg demo --notes 2
  [ "$status" -eq 0 ]
  assert_contains "$output" "the parser is the left half"
  assert_contains "$output" "handoff"
  # …and it reaches the phase's boot prompt, which is the whole point.
  run pg demo --boot-prompt 2
  assert_contains "$output" "Notes from earlier phases"
  assert_contains "$output" "the parser is the left half"
}

@test "new-handoff: the boot prompts are spliced, one per phase this one unblocks" {
  pe_newho demo 1 root complete >/dev/null
  local body; body="$(handoff phase-01-root.md)"
  # Phase 1 unblocks 2 and 3 — both, and neither collapsed into "the next one".
  assert_contains "$body" "### Phase 2"
  assert_contains "$body" "### Phase 3"
  assert_contains "$body" "start Phase 2 in this fresh session"
  assert_contains "$body" "start Phase 3 in this fresh session"
  refute_contains "$body" "{{NEXT_PROMPTS}}"
}

@test "new-handoff: the final phase gets the closeout, not a boot prompt" {
  # 4 is the last phase of the diamond and unblocks nobody.
  pe_newho demo 4 merge complete >/dev/null
  local body; body="$(handoff phase-04-merge.md)"
  assert_contains "$body" "next_phase: none"
  assert_contains "$body" "🏁 Final phase — closeout"
  assert_contains "$body" "End-to-end verification"
  refute_contains "$body" "start Phase"
}

@test "new-handoff: it refuses to overwrite, and --force repairs" {
  pe_newho demo 1 root complete >/dev/null
  run pe_newho demo 1 root complete
  [ "$status" -ne 0 ]
  assert_contains "$output" "refusing to overwrite"

  run pe_newho demo 1 root in-progress --force
  [ "$status" -eq 0 ]
  assert_contains "$output" "overwriting existing handoff"
  assert_contains "$(handoff phase-01-root.md)" "status: in-progress"
  # One INDEX row, not two: the repair replaces a handoff, it does not add one.
  [ "$(grep -c 'phase-01-root.md' "$DOCS_ROOT/docs/handoffs/demo/INDEX.md")" -eq 1 ]
}

@test "new-handoff: status defaults to complete, and the board reads it back" {
  pe_newho demo 1 root >/dev/null
  assert_contains "$(handoff phase-01-root.md)" "status: complete"
  run pg demo --ready
  assert_contains "$output" "2"
  assert_contains "$output" "3"
}

@test "new-handoff: with QA off no test-status.md is created" {
  pe_newho demo 1 root complete >/dev/null
  [ ! -f "$DOCS_ROOT/docs/handoffs/demo/test-status.md" ]
}
