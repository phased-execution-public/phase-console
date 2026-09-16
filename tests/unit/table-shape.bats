#!/usr/bin/env bats
# F20/F21 — the Phase-graph table's SHAPE and its CELLS.
#
# Everything the engine claims about readiness and scope is read out of two
# columns of one table. Before these, the parser trusted POSITION and trusted
# SILENCE: it took Depends-on from field 4 and Repos from field 6 whatever the
# header said, and it threw away any token it could not understand without a
# word. Both failure modes look exactly like a healthy plan — `LINT OK`, exit 0,
# a board that answers confidently about a plan that is not on disk.
load ../helpers/test_helper

# --- F20: shape ---------------------------------------------------------------

@test "F20: a five-column table (no Parallel-safe-with) is read by NAME, not position" {
  # The engine-1 repro. Positionally, Repos now sits where Exit criteria sat, so
  # phase 1 used to answer `--repos` with "tests,pass" and phase 2 with
  # "docs,updated" — two fabricated scopes that are disjoint, so `conflicts`
  # cleared both onto one working tree. That is the invariant the lock exists for.
  setup_docs five-column five-column
  run pg five-column --repos 1; [ "$output" = "api" ]
  run pg five-column --repos 2; [ "$output" = "api" ]
  run pg five-column --repos 3; [ "$output" = "web" ]
  run pg five-column --deps 2;  [ "$output" = "1" ]
  run pg five-column --deps 3;  [ "$output" = "2" ]
}

@test "F20: a five-column table lints clean — a correct plan is not an error" {
  setup_docs five-column five-column
  run pg five-column --lint
  [ "$status" -eq 0 ]
  assert_contains "$output" "LINT OK"
}

@test "F20: a table with no Repos column is named, not silently scoped 'all'" {
  setup_docs bad-no-repos bad-no-repos
  run pg bad-no-repos --repos 2
  [ "$output" = "all" ]
  run pg bad-no-repos --lint
  [ "$status" -eq 1 ]
  assert_contains "$output" 'no "Repos" column'
}

@test "F20: a header-less table falls back to position AND says so" {
  setup_docs linear headerless
  # Strip the header + separator rows, leaving bare data rows.
  sed '/^| Phase | Title/d; /^|------:/d' "$DOCS_ROOT/docs/plans/headerless.md" \
    > "$DOCS_ROOT/docs/plans/headerless.tmp"
  mv "$DOCS_ROOT/docs/plans/headerless.tmp" "$DOCS_ROOT/docs/plans/headerless.md"
  # Position still answers, so an old plan keeps working …
  run pg headerless --repos 2; [ "$output" = "repoa" ]
  run pg headerless --deps 2;  [ "$output" = "1" ]
  # … and the lint names the reason it is guessing.
  run pg headerless --lint
  [ "$status" -eq 1 ]
  assert_contains "$output" "no header row"
}

@test "F20: a row with fewer columns than the header is named" {
  setup_docs linear ragged
  # Inside the table (the fixture carries a `## Phases` section after it now).
  awk '{ print } /^\| 3 \|/ { print "| 4 | Delta | 3 | repoA |" }' "$DOCS_ROOT/docs/plans/ragged.md" > "$DOCS_ROOT/ragged.tmp"
  mv "$DOCS_ROOT/ragged.tmp" "$DOCS_ROOT/docs/plans/ragged.md"
  run pg ragged --lint
  [ "$status" -eq 1 ]
  assert_contains "$output" "phase 4: its table row has 4 columns but the header has 6"
}

# --- F21: cells ---------------------------------------------------------------

@test "F21: a zero-padded phase number stays on the board and is named" {
  # `08` is an invalid octal literal, so it used to take out its own row AND the
  # rows after it — `--memory-block` exited 0 having simply omitted them, and
  # readMemoryBlock built a Board that did not contain them.
  setup_docs bad-cells bad-cells
  run pg bad-cells --memory-block
  [ "$status" -eq 0 ]
  assert_contains "$output" "8"
  run pg bad-cells --deps 8
  [ "$output" = "3" ]
  run pg bad-cells --lint
  [ "$status" -eq 1 ]
  assert_contains "$output" "zero-padded"
}

@test "F21: --memory-block never emits a phase twice" {
  setup_docs bad-cells bad-cells
  run pg bad-cells --memory-block
  ready="$(printf '%s\n' "$output" | grep '^ready:' | sed 's/^ready://')"
  waiting="$(printf '%s\n' "$output" | grep '^waiting:' | sed 's/^waiting://')"
  all="$(printf '%s %s' "$ready" "$waiting" | tr ',' ' ' | tr ' ' '\n' | grep -v '^$' | sort)"
  [ "$(printf '%s\n' "$all" | wc -l)" = "$(printf '%s\n' "$all" | sort -u | wc -l)" ]
}

@test "F21: a duplicated Phase row keeps the FIRST row's dependencies" {
  # The load loop assigned by phase number but appended to the list per row, so
  # the second row won on every attribute — phase 2's dependency on 1 vanished —
  # while the number stayed in the list twice.
  setup_docs bad-cells bad-cells
  run pg bad-cells --deps 2
  [ "$output" = "1" ]
  run pg bad-cells --lint
  [ "$status" -eq 1 ]
  assert_contains "$output" "appears more than once"
}

@test "F21: a discarded Depends-on token is named instead of dropped in silence" {
  setup_docs bad-cells bad-cells
  run pg bad-cells --lint
  [ "$status" -eq 1 ]
  assert_contains "$output" 'Depends-on token "2-" was not understood'
  assert_contains "$output" 'Depends-on token "4-2" was not understood'
}

@test "F21: a lone dash means 'no dependencies' and is never reported as dropped" {
  setup_docs linear linear
  run pg linear --lint
  [ "$status" -eq 0 ]
  refute_contains "$output" "was not understood"
}

@test "F21: an ascending range still expands, and a descending one does not pretend to" {
  setup_docs ranges ranges
  run pg ranges --deps 4
  [ "$output" = "1 2 3" ]
  setup_docs bad-cells bad-cells
  run pg bad-cells --deps 4
  [ "$output" = "" ]
}

@test "F21: two handoffs for one phase are named, and the newest wins" {
  # Alphabetical order used to decide: `phase-03-auth.md` (complete, abandoned)
  # beat `phase-03-rework-auth.md` (in-progress), so the board said done and the
  # dependents unblocked on work that had been thrown away.
  setup_docs linear linear
  write_handoff linear 1 alpha complete
  write_handoff linear 2 zeta complete
  sleep 1
  write_handoff linear 2 alpha in-progress
  run pg linear --memory-block
  assert_contains "$output" "in-progress: 2"
  run pg linear --lint
  [ "$status" -eq 1 ]
  assert_contains "$output" "phase 2: 2 handoff files"
}

# --- D3: the header scan's last column ----------------------------------------
#
# A trailing `|` leaves an empty field after the last cell; without one the last
# field IS a cell. The ROW loop counted both shapes correctly and the HEADER
# loop did not — it walked `2 .. NF-1` — so a table with no trailing pipe lost
# its final column. Both columns that decide anything can sit there.

@test "D3: Repos in the last column of a trailing-pipe-less header is still found" {
  # Fell back to `all` for every phase: nothing could run beside anything, and
  # `conflicts` reported a hit for every pair in the plan.
  setup_docs no-pipe-repos-last no-pipe-repos-last
  run pg no-pipe-repos-last --repos 1; [ "$output" = "api" ]
  run pg no-pipe-repos-last --repos 2; [ "$output" = "api" ]
  run pg no-pipe-repos-last --repos 3; [ "$output" = "web" ]
}

@test "D3: Depends-on in the last column of a trailing-pipe-less header is still found" {
  # The dangerous half: `di` fell back to -1, every phase parsed dependency-free,
  # and the board reported all three ready at once.
  setup_docs no-pipe-deps-last no-pipe-deps-last
  run pg no-pipe-deps-last --deps 1; [ "$output" = "" ]
  run pg no-pipe-deps-last --deps 2; [ "$output" = "1" ]
  run pg no-pipe-deps-last --deps 3; [ "$output" = "2" ]
  run pg no-pipe-deps-last --ready
  [ "$output" = "1" ]
}

@test "D3: a trailing-pipe-less table lints clean in both shapes" {
  setup_docs no-pipe-repos-last no-pipe-repos-last
  run pg no-pipe-repos-last --lint
  [ "$status" -eq 0 ]
  assert_contains "$output" "LINT OK"
  setup_docs no-pipe-deps-last no-pipe-deps-last
  run pg no-pipe-deps-last --lint
  [ "$status" -eq 0 ]
  assert_contains "$output" "LINT OK"
}
