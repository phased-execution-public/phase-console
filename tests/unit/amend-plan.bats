#!/usr/bin/env bats
# amend-plan.sh — the one writer of a plan amendment (measured-console phase 30):
# a section numbered last, THEN its graph row, THEN the dated note, THEN the
# frontmatter count; the lint has the last word and the original comes back.
load ../helpers/test_helper

plan() { printf '%s' "$DOCS_ROOT/docs/plans/amendable.md"; }

@test "amend-plan: a well-formed amendment — numbered last, in all four places, accepted by the lint" {
  setup_docs amendable amendable
  run pe_amend amendable --title "Gamma thing" --size M --repos repoA,repoB --depends 2 --from D-7 --goal "Cover the gap"
  [ "$status" -eq 0 ]
  [ "$output" = "3" ]
  p="$(cat "$(plan)")"
  assert_contains "$p" "### Phase 3 — Gamma thing"
  assert_contains "$p" "- **Goal:** Cover the gap"
  assert_contains "$p" "- **Size:** M"
  assert_contains "$p" "- **Depends on:** 2"
  assert_contains "$p" "- **Amendment:** 1 (2026-10-28) · from D-7"
  assert_contains "$p" "| 3 | Gamma thing | 2 | — | repoA, repoB |"
  assert_contains "$p" "> *(Amendment 1, 2026-10-28)* Phase 3 — Gamma thing: Cover the gap (from deferred D-7)"
  assert_contains "$p" "phases: 3"
  run pg amendable --lint
  [ "$status" -eq 0 ]
  refute_contains "$output" "F49"
  run pg amendable --deps 3
  [ "$output" = "2" ]
  run pg amendable --repos 3
  [ "$output" = "repoa,repob" ]
  # the section sits before the sections that followed ## Phases
  sec="$(grep -n '^### Phase 3' "$(plan)" | cut -d: -f1)"
  err="$(grep -n '^## Operator errands' "$(plan)" | cut -d: -f1)"
  [ "$sec" -lt "$err" ]
}

@test "amend-plan: the section is written before the graph row (#416) — the order is the fix" {
  setup_docs amendable amendable
  # Stub `mv` so each atomic write is observable: after the FIRST rename the
  # plan holds the section and no row; after the SECOND, the row too.
  stubs="$BATS_TEST_TMPDIR/stubs"; mkdir -p "$stubs"
  cat > "$stubs/mv" <<STUB
#!/bin/sh
/bin/mv "\$@"
n=\$(cat "$BATS_TEST_TMPDIR/n" 2>/dev/null || echo 0); n=\$((n + 1)); echo \$n > "$BATS_TEST_TMPDIR/n"
if grep -q '^### Phase 3' "\$2"; then s=1; else s=0; fi
if grep -q '^| 3 |' "\$2"; then r=1; else r=0; fi
if grep -q 'Amendment 1,' "\$2"; then q=1; else q=0; fi
echo "\$n section=\$s row=\$r note=\$q" >> "$BATS_TEST_TMPDIR/trace"
STUB
  chmod +x "$stubs/mv"
  PATH="$stubs:$PATH" run pe_amend amendable --title "Gamma" --size S --repos repoA --depends 2 --gate "manual sign-off"
  [ "$status" -eq 0 ]
  trace="$(cat "$BATS_TEST_TMPDIR/trace")"
  first="$(printf '%s\n' "$trace" | sed -n 1p)"; second="$(printf '%s\n' "$trace" | sed -n 2p)"
  third="$(printf '%s\n' "$trace" | sed -n 3p)"
  [ "$first" = "1 section=1 row=0 note=0" ]
  [ "$second" = "2 section=1 row=1 note=0" ]
  [ "$third" = "3 section=1 row=1 note=1" ]
}

@test "amend-plan: a gated amendment carries *(GATED)* in heading and row, and its Gate-check" {
  setup_docs amendable amendable
  run pe_amend amendable --title "Sign off" --size S --repos repoA --depends 1,2 --gate "cmd git status"
  [ "$status" -eq 0 ]
  p="$(cat "$(plan)")"
  assert_contains "$p" "### Phase 3 — Sign off *(GATED)*"
  assert_contains "$p" "- **Gate-check:** cmd git status"
  assert_contains "$p" "| 3 | Sign off *(GATED)* | 1, 2 |"
  run pg amendable --gate-kind 3
  [ "$output" = "auto" ]
  run pg amendable --lint
  [ "$status" -eq 0 ]
}

@test "amend-plan: an unknown gate type is refused (exit 2), and nothing is written" {
  setup_docs amendable amendable
  cp "$(plan)" "$BATS_TEST_TMPDIR/before"
  run pe_amend amendable --title "X" --size S --repos repoA --depends 1 --gate "bogus thing"
  [ "$status" -eq 2 ]
  assert_contains "$output" "bogus"
  cmp "$(plan)" "$BATS_TEST_TMPDIR/before"
}

@test "amend-plan: bad arguments exit 2 — size, missing title, a dependency the plan lacks" {
  setup_docs amendable amendable
  cp "$(plan)" "$BATS_TEST_TMPDIR/before"
  run pe_amend amendable --title "X" --size XL --repos repoA --depends 1
  [ "$status" -eq 2 ]
  run pe_amend amendable --size S --repos repoA --depends 1
  [ "$status" -eq 2 ]
  run pe_amend amendable --title "X" --size S --repos repoA --depends 9
  [ "$status" -eq 2 ]
  assert_contains "$output" "phase 9"
  run pe_amend amendable --title "X" --size S --repos repoA
  [ "$status" -eq 2 ]
  run pe_amend amendable --title "X" --size S --repos repoA --depends 1 --bogus
  [ "$status" -eq 2 ]
  run pe_amend no-such-plan --title "X" --size S --repos repoA --depends 1
  [ "$status" -eq 2 ]
  cmp "$(plan)" "$BATS_TEST_TMPDIR/before"
}

@test "amend-plan: the amendment count K increments, and phases: follows the table" {
  setup_docs amendable amendable
  run pe_amend amendable --title "One" --size S --repos repoA --depends - --date 2026-10-28
  [ "$output" = "3" ]
  run pe_amend amendable --title "Two" --size S --repos repoA --depends 3 --date 2026-10-29
  [ "$output" = "4" ]
  p="$(cat "$(plan)")"
  assert_contains "$p" "*(Amendment 1, 2026-10-28)* Phase 3 — One"
  assert_contains "$p" "*(Amendment 2, 2026-10-29)* Phase 4 — Two"
  assert_contains "$p" "- **Amendment:** 2 (2026-10-29)"
  assert_contains "$p" "phases: 4"
  run pg amendable --lint
  [ "$status" -eq 0 ]
  refute_contains "$output" "F49"
}

@test "amend-plan: a plan with no blockquote under its title gets the note straight under the H1" {
  setup_docs linear linear
  run pe_amend linear --title "Delta" --size S --repos repoA --depends 3
  [ "$status" -eq 0 ]
  [ "$output" = "4" ]
  run sed -n '/^# Linear/,/^## /p' "$DOCS_ROOT/docs/plans/linear.md"
  assert_contains "$output" "> *(Amendment 1, 2026-10-28)* Phase 4 — Delta: Delta"
  run pg linear --lint
  [ "$status" -eq 0 ]
}

@test "amend-plan: when the lint finds a problem the original did not have, the plan is restored (exit 1)" {
  setup_docs amendable amendable
  cp "$(plan)" "$BATS_TEST_TMPDIR/before"
  # a phase gate naming a phase the plan does not have fails the lint
  run pe_amend amendable --title "Bad gate" --size S --repos repoA --depends 1 --gate "phase 99"
  [ "$status" -eq 1 ]
  assert_contains "$output" "phase 99"
  cmp "$(plan)" "$BATS_TEST_TMPDIR/before"
}

@test "amend-plan: a closed plan is not amended" {
  setup_docs amendable amendable
  pe_close amendable --status abandoned --reason "done"
  run pe_amend amendable --title "X" --size S --repos repoA --depends 1
  [ "$status" -eq 2 ]
  assert_contains "$output" "closed"
}
