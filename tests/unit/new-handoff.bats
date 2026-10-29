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
# The boot prompts are `phase-graph.sh --boot-prompt`'s and are composed when
# they are READ (`next-phase-prompt.sh`, Phase Console), never frozen into the
# handoff (#338): what is asserted here is that the section holds the pointer
# to that composer — a handoff whose section is the literal `{{NEXT_PROMPTS}}`
# placeholder, or a prompt that was true only at scaffold time, is the failure.

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
  # Until the session writes what the phase did, the scaffold is not finished
  # work, and the validator says so by name (#46)…
  run pe_validate demo
  [ "$status" -ne 0 ]
  assert_contains "$output" "handoff-scaffold-complete"
  # …and once it has, the scaffold's sections are all the validator wants.
  local f="$DOCS_ROOT/docs/handoffs/demo/phase-01-root.md"
  awk '{ print } /^## What this phase did/ { print "The root builds." }' "$f" > "$f.new" && mv "$f.new" "$f"
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
  # Written the way a finishing session writes it: appended under the heading —
  # with the body written too, since only a FINISHED handoff's notes are read
  # and a scaffold whose "What this phase did" is empty is not finished (#46).
  awk '
    /^## What this phase did/ { print; print "The root builds."; next }
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

@test "new-handoff: the section is a pointer the readers compose at read time — no prompt is frozen (#338)" {
  pe_newho demo 1 root complete >/dev/null
  local body; body="$(handoff phase-01-root.md)"
  # The composer, named runnable, with this plan and this phase …
  assert_contains "$body" 'next-phase-prompt.sh demo 1'
  assert_contains "$body" '--phase <M>'
  # … and no prompt, no phase set, no fence a reader could mistake for one.
  refute_contains "$body" "### Phase 2"
  refute_contains "$body" "start Phase"
  refute_contains "$body" "boot-shared"
  refute_contains "$body" "/phased-execution"
  refute_contains "$body" "{{NEXT_PROMPTS}}"
}

@test "new-handoff: a note left after the scaffold reaches the composed prompt — the handoff froze nothing (#338)" {
  cp "$PE_DIR/tests/fixtures/plans/linear.md" "$DOCS_ROOT/docs/plans/demo.md"
  pe_newho demo 1 alpha in-progress >/dev/null
  # The phase finishes later, and leaves a note for phase 2 in the meantime.
  local f="$DOCS_ROOT/docs/handoffs/demo/phase-01-alpha.md"
  awk '{ print } /^## What this phase did/ { print "Alpha built." }' "$f" > "$f.new" && mv "$f.new" "$f"
  sed -i.bak 's/^status: in-progress/status: complete/' "$f" && rm -f "$f.bak"
  printf '\n## Notes for later phases\n- **Phase 2:** the late note arrives whole.\n' >> "$f"
  run pe_nextp demo 1
  [ "$status" -eq 0 ]
  assert_contains "$output" "start Phase 2 in this fresh session"
  assert_contains "$output" "the late note arrives whole"
  # The prompt the reader composes names this handoff to read first.
  assert_contains "$output" "- docs/handoffs/demo/phase-01-alpha.md"
  refute_contains "$(cat "$f")" "start Phase 2"
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

@test "new-handoff: the closeout writes the plan's \`complete\` LAST — after the end-to-end verification and the all-done check (#153)" {
  # `complete` is the word every reader acts on, so it is written only once
  # every line before it ran green. The closeout used to open with "Set
  # `status: complete`" and only then say "Run §End-to-end verification" —
  # the order a finishing session follows, and the order the board then reads.
  pe_newho demo 4 merge complete >/dev/null
  local f="$DOCS_ROOT/docs/handoffs/demo/phase-04-merge.md"
  local verify alldone flip
  verify="$(grep -n 'End-to-end verification' "$f" | head -1 | cut -d: -f1)"
  alldone="$(grep -n 'Confirm every phase is' "$f" | head -1 | cut -d: -f1)"
  flip="$(grep -nF 'status: complete` in `docs/plans/demo.md' "$f" | head -1 | cut -d: -f1)"
  [ -n "$verify" ]
  [ -n "$alldone" ]
  [ -n "$flip" ]
  [ "$flip" -gt "$verify" ]
  [ "$flip" -gt "$alldone" ]
  # …and the line says why: a line not run is not a line green.
  assert_contains "$(sed -n "${flip}p" "$f")" "owed, deferred or skipped"
}

@test "new-handoff: the batching hint is a person's — the console runs one phase per session (#153)" {
  # A fan-out (the diamond's root unblocks 2 and 3)…
  pe_newho demo 1 root complete >/dev/null
  local body; body="$(handoff phase-01-root.md)"
  assert_contains "$body" "The console runs one phase per session"
  assert_contains "$body" "driving by hand"
  # …and a lone next phase, sequential on this one: neither offers a supervised
  # session another phase to continue into.
  cp "$PE_DIR/tests/fixtures/plans/linear.md" "$DOCS_ROOT/docs/plans/lin.md"
  pe_newho lin 1 alpha complete >/dev/null
  body="$(cat "$DOCS_ROOT/docs/handoffs/lin/phase-01-alpha.md")"
  assert_contains "$body" "The console runs one phase per session"
  assert_contains "$body" "driving by hand"
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

@test "new-handoff: --force rewrites the existing INDEX row's status, and says updated only when it did (#265)" {
  local index="$DOCS_ROOT/docs/handoffs/demo/INDEX.md"
  pe_newho demo 1 root in-progress >/dev/null
  assert_contains "$(grep 'phase-01-root.md' "$index")" "| in-progress |"
  run pe_newho demo 1 root complete --force
  [ "$status" -eq 0 ]
  [ "$(grep -c 'phase-01-root.md' "$index")" -eq 1 ]
  assert_contains "$(grep 'phase-01-root.md' "$index")" "| complete |"
  refute_contains "$(grep 'phase-01-root.md' "$index")" "in-progress"
  assert_contains "$output" "updated $index"
  # The same status again changes nothing, and the script does not claim it did.
  run pe_newho demo 1 root complete --force
  [ "$status" -eq 0 ]
  refute_contains "$output" "updated $index"
  assert_contains "$output" "INDEX.md already reads complete"
}

@test "new-handoff: --force keeps every other cell of a hand-written INDEX row (#265)" {
  local dir="$DOCS_ROOT/docs/handoffs/demo"
  pe_newho demo 2 left blocked >/dev/null
  # A person's row: a wider title, a trailing note column.
  grep -v 'phase-02-left.md' "$dir/INDEX.md" > "$dir/INDEX.tmp" && mv "$dir/INDEX.tmp" "$dir/INDEX.md"
  printf '| 02 | Left — the long title | blocked | [phase-02-left.md](phase-02-left.md) | see #9 |\n' >> "$dir/INDEX.md"
  pe_newho demo 2 left in-progress --force >/dev/null
  [ "$(grep 'phase-02-left.md' "$dir/INDEX.md")" = '| 02 | Left — the long title | in-progress | [phase-02-left.md](phase-02-left.md) | see #9 |' ]
}

@test "new-handoff: status defaults to complete — and the board waits for the body before it reads it back" {
  pe_newho demo 1 root >/dev/null
  assert_contains "$(handoff phase-01-root.md)" "status: complete"
  # An empty scaffold is not finished work (#46): nothing it unblocks is ready
  # yet, and the lint names why.
  run pg demo --ready
  [ -z "$output" ]
  run pg demo --lint
  [ "$status" -ne 0 ]
  assert_contains "$output" "handoff-scaffold-complete"
  # The session writes what the phase did: now the board reads it done.
  local f="$DOCS_ROOT/docs/handoffs/demo/phase-01-root.md"
  awk '{ print } /^## What this phase did/ { print "The root builds; two branches can start." }' "$f" > "$f.new" && mv "$f.new" "$f"
  run pg demo --ready
  assert_contains "$output" "2"
  assert_contains "$output" "3"
  run pg demo --lint
  refute_contains "$output" "handoff-scaffold-complete"
}

@test "new-handoff: --force … complete writes the body first and flips status last — a repair cut off never reads complete" {
  pe_newho demo 1 root blocked >/dev/null
  local dir="$DOCS_ROOT/docs/handoffs/demo"
  # Cut the repair off after the body is written and before the flip: the
  # INDEX refuses the row it will try to add.
  grep -v 'phase-01-root.md' "$dir/INDEX.md" > "$dir/INDEX.tmp" && mv "$dir/INDEX.tmp" "$dir/INDEX.md"
  chmod 444 "$dir/INDEX.md"
  run pe_newho demo 1 root complete --force
  chmod 644 "$dir/INDEX.md"
  [ "$status" -ne 0 ]
  assert_contains "$(handoff phase-01-root.md)" "status: blocked"
  assert_contains "$(handoff phase-01-root.md)" "## ▶ Start next phase"
  refute_contains "$(handoff phase-01-root.md)" "{{NEXT_PROMPTS}}"
  # No draft is left behind for a reader to find.
  [ -z "$(ls "$dir" | grep -F '.draft.' || true)" ]

  # Uninterrupted, the same repair ends on the flip.
  run pe_newho demo 1 root complete --force
  [ "$status" -eq 0 ]
  assert_contains "$(handoff phase-01-root.md)" "status: complete"
  # The flip keeps the frontmatter line's comment and touches no other line.
  [ "$(grep -c '^status:' "$dir/phase-01-root.md")" -eq 1 ]
  assert_contains "$(grep '^status:' "$dir/phase-01-root.md")" "# complete | in-progress"
}

@test "new-handoff: with QA off no test-status.md is created" {
  pe_newho demo 1 root complete >/dev/null
  [ ! -f "$DOCS_ROOT/docs/handoffs/demo/test-status.md" ]
}

# A handoff is a brief (measured-console phase 4): its summary comes first — the
# brief hands it to every dependent phase — and it names the skills the NEXT
# session should call, beside the ones this one used.
@test "new-handoff: the scaffold carries suggested_skills beside skills_used, and the Summary first" {
  setup_docs linear linear
  run pe_newho linear 1 alpha complete
  [ "$status" -eq 0 ]
  f="$DOCS_ROOT/docs/handoffs/linear/phase-01-alpha.md"
  grep -q '^skills_used: \[\]' "$f"
  grep -q '^suggested_skills: \[\]' "$f"
  sum="$(grep -n '^## Summary$' "$f" | cut -d: -f1)"
  did="$(grep -n '^## What this phase did$' "$f" | cut -d: -f1)"
  [ -n "$sum" ] && [ -n "$did" ] && [ "$sum" -lt "$did" ]
  [ "$(grep -n '^## ' "$f" | head -1 | cut -d: -f2-)" = "## Summary" ]
}
