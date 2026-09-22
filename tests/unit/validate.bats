#!/usr/bin/env bats
# validate.sh — the deterministic plan/handoff validator (F1/F2/F3/F10).
# RED until scripts/validate.sh exists. Content assertions guard against the
# "script missing => non-zero => false green" trap.
#
# NOTE: negative fixtures are staged under NEUTRAL slugs (badrow/missingdep/loop)
# so an asserted keyword ("undefined", "cycle") can't accidentally match the slug
# that the tool echoes back in headers/messages.
load ../helpers/test_helper

@test "validate: clean linear plan passes (exit 0)" {
  setup_docs linear linear
  run pe_validate linear
  [ "$status" -eq 0 ]
}

@test "validate: every clean fixture passes" {
  for fx in diamond ranges gated sizes outoforder; do
    setup_docs "$fx" "$fx"
    run pe_validate "$fx"
    [ "$status" -eq 0 ] || { echo "fixture $fx unexpectedly failed validate: $output"; return 1; }
  done
}

@test "validate: malformed Phase cell is rejected and named (F1)" {
  setup_docs bad-malformed-table badrow
  run pe_validate badrow
  [ "$status" -ne 0 ]
  assert_contains "$output" "2a"
}

@test "validate: undefined dependency is rejected and named (F2)" {
  setup_docs bad-undefined-dep missingdep
  run pe_validate missingdep
  [ "$status" -ne 0 ]
  assert_contains "$output" "undefined"
  assert_contains "$output" "9"
}

@test "validate: dependency cycle is detected and named (F3)" {
  setup_docs bad-cycle loop
  run pe_validate loop
  [ "$status" -ne 0 ]
  assert_contains "$output" "cycle"
}

@test "F10: a handoff with NO depends_on line is judged, never a silent death" {
  # Under `set -eo pipefail` the missing line used to fail the grep pipeline
  # and kill the validator mid-loop: exit 1, no ✗, no summary — the silent-red
  # shape this script exists to prevent. Dep-less phase: absent line means [].
  setup_docs scoped scoped
  write_handoff scoped 1 root complete
  printf '\n## Start next phase(s)\nnothing.\n' >> "$DOCS_ROOT/docs/handoffs/scoped/phase-01-root.md"
  run pe_validate scoped
  [ "$status" -eq 0 ]
  assert_contains "$output" "VALIDATE OK"
}

@test "F10: a missing depends_on on a phase WITH deps reports the disagreement out loud" {
  setup_docs scoped scoped
  write_handoff scoped 2 api complete
  printf '\n## Start next phase(s)\nnothing.\n' >> "$DOCS_ROOT/docs/handoffs/scoped/phase-02-api.md"
  run pe_validate scoped
  [ "$status" -eq 1 ]
  assert_contains "$output" "disagrees with plan graph"
  assert_contains "$output" "VALIDATE FAIL"
}

@test "G13: a closed plan's garbage handoff status warns but stays exit 0" {
  setup_docs closed closedp
  write_handoff closedp 1 pasted "complete + write the closeout handoff. Verify every step"
  run pe_validate closedp
  [ "$status" -eq 0 ]
  assert_contains "$output" "VALIDATE SKIPPED"
  assert_contains "$output" "is not one of complete|in-progress|blocked|pending"
}

@test "G13: a closed plan with clean handoffs stays quiet" {
  setup_docs closed closedp
  write_handoff closedp 1 clean complete
  run pe_validate closedp
  [ "$status" -eq 0 ]
  [[ "$output" != *"is not one of"* ]]
}

# --- The four checks that moved to F1 tier in 5.0.0 (zero-touch-console P3) ---
@test "validate: names each of the four promoted checks, and passes a plan carrying a full manifest" {
  setup_docs bad-gated-no-check g1;            run pe_validate g1;  [ "$status" -ne 0 ]; assert_contains "$output" "gate-directive-missing"
  setup_docs bad-gate-type-unknown g2;         run pe_validate g2;  [ "$status" -ne 0 ]; assert_contains "$output" "gate-type-unknown"
  setup_docs bad-empty-verification-open g3;   run pe_validate g3;  [ "$status" -ne 0 ]; assert_contains "$output" "verification-empty-open"
  setup_docs bad-decision-unowned g4;          run pe_validate g4;  [ "$status" -ne 0 ]; assert_contains "$output" "decision-outstanding-unowned"
  setup_docs credentials ok;                   run pe_validate ok;  [ "$status" -eq 0 ]
}

# --------------------------------------------------------------------------
# The forward-notes family: F26 gates, F30 warns (phase 11)
# --------------------------------------------------------------------------

@test "F26: a note addressed to a phase this plan does not have FAILS, and names it" {
  setup_docs diamond diamond
  write_handoff diamond 1 root complete
  cat >> "$DOCS_ROOT/docs/handoffs/diamond/phase-01-root.md" <<'NOTE'

## Notes for later phases

- **Phase 4:** the merge reads both halves.
- **Phase 40:** this one is addressed to nobody.
NOTE
  run pe_validate diamond
  [ "$status" -ne 0 ]
  assert_contains "$output" "note-target-unknown"
  assert_contains "$output" "40"
  assert_contains "$output" "F26"
  # The well-addressed one is not an offence, and `Next`/`All` never are: they
  # are relations, and a relation always has a reader.
  refute_contains "$output" "note for phase 4,"
}

@test "F26: \`Next\` and \`All\` are never note-target-unknown" {
  setup_docs diamond diamond
  write_handoff diamond 1 root complete
  cat >> "$DOCS_ROOT/docs/handoffs/diamond/phase-01-root.md" <<'NOTE'

## Notes for later phases

- **Next:** a dependency edge, not a number.
- **All:** everybody after me.
NOTE
  # The lint arm, not the whole validator: `write_handoff` scaffolds a minimal
  # handoff with no boot section, so `validate.sh` has a second, unrelated
  # reason to fail and "exit 0" would be proving something else.
  run pg diamond --lint
  [ "$status" -eq 0 ]
  refute_contains "$output" "note-target-unknown"
}

@test "F30: a note addressed to a phase that is already DONE warns, and the lint still passes" {
  setup_docs diamond diamond
  write_handoff diamond 1 root complete
  write_handoff diamond 2 left complete
  cat >> "$DOCS_ROOT/docs/handoffs/diamond/phase-01-root.md" <<'NOTE'

## Notes for later phases

- **Phase 2:** phase 2 has already been and gone.
- **Phase 4:** phase 4 has not.
NOTE
  run pg diamond --lint
  # Advisory: the phase exists and the note is well-formed — only its reader
  # is gone. Its own id, because an id that both gates and warns cannot answer
  # "did the lint fail?".
  [ "$status" -eq 0 ]
  assert_contains "$output" "F30"
  assert_contains "$output" "note-target-done"
  assert_contains "$output" "phase 2"
  refute_contains "$output" "note for phase 4 will never"
  assert_contains "$output" "LINT OK"
}
