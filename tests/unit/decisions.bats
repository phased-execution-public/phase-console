#!/usr/bin/env bats
# The decision manifest (zero-touch-console phase 3, chapter 13 §1.1): a
# `## Decisions` table in the plan, one row per key of a closed seventeen-key
# vocabulary, read by `phase-graph.sh --decisions [N]` as
# key<TAB>state<TAB>owner<TAB>blocking<TAB>source<TAB>value, with the mutable
# twin `docs/handoffs/<slug>/decisions.md` (written only by decisions.sh)
# merged OVER the plan's rows, and a phase's own rows over both. The JS reader
# is held to this output byte for byte by viewer/test/engine-parity.test.ts.
#
# The four checks that moved to F1 tier in 5.0.0 are asserted here BY NAME:
# gate-directive-missing and gate-type-unknown (F24), verification-empty-open
# (F14), decision-outstanding-unowned (F25, with its key/state siblings).
load ../helpers/test_helper

twin() {  # twin <slug> <rows…>  — write a decisions.md twin in the writer's shape
  local slug="$1"; shift
  {
    printf '# Decisions — %s\n\n## Decisions\n\n' "$slug"
    printf '| key | value | owner | state | blocking | source | evidence | phase |\n'
    printf '|---|---|---|---|---|---|---|---|\n'
    printf '%s\n' "$@"
  } > "$DOCS_ROOT/docs/handoffs/$slug/decisions.md"
}

@test "--decisions: every row of the plan's table, DECISION_KEYS order, noise stripped" {
  setup_docs decisions decisions
  run pg decisions --decisions
  [ "$status" -eq 0 ]
  [ "$(printf '%s\n' "$output" | wc -l | tr -d ' ')" = "17" ]
  [ "$(printf '%s\n' "$output" | head -1 | cut -f1)" = "permission.policy" ]
  [ "$(printf '%s\n' "$output" | tail -1 | cut -f1)" = "announce" ]
  # bold and backticks off the key/state, TRUE normalised, the value kept as written
  assert_contains "$output" "$(printf 'credentials\tanswered\toperator\tyes\tplan\t`gh`, `npm-token`')"
  # an outstanding row with an owner is legal and reads back as such
  assert_contains "$output" "$(printf 'waits\toutstanding\tdev-lead\tyes\tplan\t')"
  # a waived row, and a default-sourced one
  assert_contains "$output" "$(printf 'qa.exhausted\twaived\toperator\tno\tplan\tQA is off on this plan')"
  assert_contains "$output" "$(printf 'ambiguity\tanswered\tpolicy\tno\tdefault\truling')"
}

@test "--decisions: a plan with no manifest prints nothing and lints OK" {
  setup_docs linear linear
  run pg linear --decisions
  [ "$status" -eq 0 ]
  [ -z "$output" ]
  run pg linear --lint
  [ "$status" -eq 0 ]
}

@test "--decisions N: the phase's own row replaces the plan-wide one, whole" {
  setup_docs decisions decisions
  run pg decisions --decisions 2
  [ "$status" -eq 0 ]
  assert_contains "$output" "$(printf 'waits\tanswered\tdev-lead\tyes\tplan\t`gh:acme/widgets#run/1` · 45m')"
  [[ "$output" != *"$(printf 'waits\toutstanding')"* ]]
  # another phase sees the plan-wide row, and so does the plan view
  run pg decisions --decisions 1
  assert_contains "$output" "$(printf 'waits\toutstanding\tdev-lead')"
  run pg decisions --decisions
  assert_contains "$output" "$(printf 'waits\toutstanding\tdev-lead')"
  run pg decisions --decisions 9
  [ "$status" -eq 2 ]
}

@test "--decisions: the twin's rows merge OVER the plan's; a twin row scoped to a phase over both" {
  setup_docs decisions decisions
  twin decisions \
    '| `credentials` | `gh` only — npm retired | operator | answered | yes | run | decisions.sh | — |' \
    '| `waits` | bounded at 30m for phase 2 | operator | answered | yes | run | decisions.sh | 2 |' \
    '| `stop` | halt-on-everything | operator | answered | no | ruling | ruling r-17 | |'
  run pg decisions --decisions
  [ "$status" -eq 0 ]
  assert_contains "$output" "$(printf 'credentials\tanswered\toperator\tyes\trun\t`gh` only — npm retired')"
  assert_contains "$output" "$(printf 'stop\tanswered\toperator\tno\truling\thalt-on-everything')"
  # the plan-wide view does not see the phase-2 twin row
  assert_contains "$output" "$(printf 'waits\toutstanding\tdev-lead')"
  run pg decisions --decisions 2
  assert_contains "$output" "$(printf 'waits\tanswered\toperator\tyes\trun\tbounded at 30m for phase 2')"
  [ "$(printf '%s\n' "$output" | wc -l | tr -d ' ')" = "17" ]
}

@test "--decisions: a table inside a fence is an example, not a manifest" {
  setup_docs linear linear
  printf '\n## Decisions\n\n```\n| key | state |\n|---|---|\n| `stop` | answered |\n```\n' >> "$DOCS_ROOT/docs/plans/linear.md"
  run pg linear --decisions
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "--gate-kind: a *(GATED)* heading with no directive answers ai — the default gates.env names" {
  setup_docs decisions decisions
  run pg decisions --gate-kind 3
  [ "$output" = "ai" ]
  run pg decisions --gate-status 3
  [ "$status" -eq 1 ]
  [[ "$output" == "ai: "* ]]
  assert_contains "$output" "someone looks at it"
}

@test "lint F24: gate-directive-missing, by name" {
  setup_docs bad-gated-no-check nocheck
  run pe_validate nocheck
  [ "$status" -ne 0 ]
  assert_contains "$output" "phase 2: gate-directive-missing"
  [[ "$output" != *"phase 1: gate-directive-missing"* ]]
}

@test "lint F24: gate-type-unknown, by name" {
  setup_docs bad-gate-type-unknown badtype
  run pe_validate badtype
  [ "$status" -ne 0 ]
  assert_contains "$output" 'phase 2: gate-type-unknown — Gate-check type "review"'
}

@test "lint F14: verification-empty-open, by name, on every empty shape" {
  setup_docs bad-empty-verification-open bev
  run pe_validate bev
  [ "$status" -ne 0 ]
  assert_contains "$output" "phase 1: verification-empty-open"
  assert_contains "$output" "phase 2: verification-empty-open"
  assert_contains "$output" "phase 3: verification-empty-open"
  [[ "$output" != *"phase 4: verification-empty-open"* ]]
}

@test "lint F25: decision-outstanding-unowned, and its key/state siblings, by name" {
  setup_docs bad-decision-unowned unowned
  run pe_validate unowned
  [ "$status" -ne 0 ]
  assert_contains "$output" 'decision row `credentials` in the plan: decision-outstanding-unowned'
  assert_contains "$output" 'decision row `gate` in the plan: decision-key-unknown'
  assert_contains "$output" 'decision row `relay` in the plan: decision-state-unknown'
  assert_contains "$output" 'decision row `stop` in the plan: decision-source-unknown'
  [[ "$output" != *'decision row `gates`'* ]]
}

@test "lint F25: the twin's rows are checked too, and named as the twin's" {
  setup_docs linear linear
  twin linear '| `relay` | | | outstanding | yes | run | | 2 |'
  run pg linear --lint
  [ "$status" -ne 0 ]
  assert_contains "$output" 'decision row `relay` in decisions.md (phase 2): decision-outstanding-unowned'
}

@test "lint: the decisions fixture fails on ONE thing only — its undeclared gate — and the plan named its own" {
  setup_docs decisions decisions
  run pg decisions --lint
  [ "$status" -ne 0 ]
  assert_contains "$output" "LINT FAIL: decisions (1 issue[s])"
  assert_contains "$output" "phase 3: gate-directive-missing"
}

@test "boot-prompt: the phase's decision rows ride between the bootstrap list and the scope block, outstanding first, with the --needs duty" {
  setup_docs decisions decisions
  run pg decisions --boot-prompt 1
  [ "$status" -eq 0 ]
  assert_contains "$output" "This phase's DECISIONS"
  assert_contains "$output" "  - [outstanding] waits — owner dev-lead, blocking yes: (no value yet)"
  assert_contains "$output" "  - [answered] relay: off"
  assert_contains "$output" "blocked --needs <key> --reason"
  assert_contains "$output" '`--needs` is REQUIRED on `blocked` and `needs-human`'
  # order: bootstrap list → decisions → scope
  boot="$(printf '%s\n' "$output" | grep -n 'Bootstrap from disk only' | cut -d: -f1)"
  dec="$(printf '%s\n' "$output" | grep -n "This phase's DECISIONS" | cut -d: -f1)"
  scope="$(printf '%s\n' "$output" | grep -n "This phase's SCOPE" | cut -d: -f1)"
  [ "$boot" -lt "$dec" ] && [ "$dec" -lt "$scope" ]
  # phase 2's own waits row is the one phase 2's prompt shows
  run pg decisions --boot-prompt 2
  assert_contains "$output" '  - [answered] waits: `gh:acme/widgets#run/1` · 45m'
}

@test "boot-prompt: a plan with no manifest still tells the session the keys and the duty" {
  setup_docs linear linear
  run pg linear --boot-prompt 1
  assert_contains "$output" "this plan carries no \`## Decisions\` manifest — the keys are: permission.policy, permission.destructive, credentials"
  assert_contains "$output" "blocked --needs <key> --reason"
}

# --- decisions.sh — the twin writer (the qa-mode.sh shape) ---------------------
@test "decisions.sh answer: writes the twin in the readers' shape, and reads its own row back" {
  setup_docs decisions decisions
  run pe_decisions decisions answer waits --value "gh:acme/x#run/9 · 20m" --by op
  [ "$status" -eq 0 ]
  [ "$output" = "$(printf 'waits\tanswered\top\tyes\trun\tgh:acme/x#run/9 · 20m')" ]
  f="$DOCS_ROOT/docs/handoffs/decisions/decisions.md"
  [ -f "$f" ]
  grep -qxF '| key | value | owner | state | blocking | source | evidence | phase |' "$f"
  grep -qxF '| `waits` | gh:acme/x#run/9 · 20m | op | answered | yes | run | decisions.sh 2026-09-14 | — |' "$f"
  # the plan's row is replaced whole (source `run` now), the rest untouched
  run pg decisions --decisions
  assert_contains "$output" "$(printf 'waits\tanswered\top\tyes\trun\t')"
  assert_contains "$output" "$(printf 'relay\tanswered\toperator\tyes\tplan\toff')"
  [ "$(printf '%s\n' "$output" | wc -l | tr -d ' ')" = "17" ]
}

@test "decisions.sh: idempotent — the same answer twice leaves the bytes alone; a changed one replaces the row in place" {
  setup_docs decisions decisions
  pe_decisions decisions answer waits --value "first" --by op >/dev/null
  f="$DOCS_ROOT/docs/handoffs/decisions/decisions.md"
  cp "$f" "$BATS_TEST_TMPDIR/once.md"
  pe_decisions decisions answer waits --value "first" --by op >/dev/null
  cmp "$BATS_TEST_TMPDIR/once.md" "$f"
  pe_decisions decisions answer waits --value "second" --by op >/dev/null
  [ "$(grep -c '^| `waits` |' "$f")" = "1" ]
  grep -q '| second |' "$f"
  [ -z "$(ls "$DOCS_ROOT/docs/handoffs/decisions"/decisions.md.tmp.* 2>/dev/null || true)" ]
}

@test "decisions.sh --phase N: a phase-scoped row shows only for that phase, beside the plan-wide one" {
  setup_docs decisions decisions
  run pe_decisions decisions --phase 3 waive relay --reason "no relay in the gated phase" --by op
  [ "$status" -eq 0 ]
  [ "$output" = "$(printf 'relay\twaived\top\tyes\trun\tno relay in the gated phase')" ]
  run pg decisions --decisions 3;  assert_contains "$output" "$(printf 'relay\twaived\top')"
  run pg decisions --decisions 1;  assert_contains "$output" "$(printf 'relay\tanswered\toperator\tyes\tplan\toff')"
  run pg decisions --decisions;    assert_contains "$output" "$(printf 'relay\tanswered\toperator\tyes\tplan\toff')"
  run pe_decisions decisions list --phase 3
  assert_contains "$output" "$(printf 'relay\twaived\top')"
}

@test "decisions.sh: an answer keeps the merged row's blocking unless told; --blocking overrides" {
  setup_docs decisions decisions
  run pe_decisions decisions answer mcp --value "context7" --by op
  [ "$(printf '%s' "$output" | cut -f4)" = "no" ]
  run pe_decisions decisions answer credentials --value "gh only" --by op
  [ "$(printf '%s' "$output" | cut -f4)" = "yes" ]
  run pe_decisions decisions answer credentials --value "gh only" --by op --blocking no
  [ "$(printf '%s' "$output" | cut -f4)" = "no" ]
}

@test "decisions.sh promote: a ruling becomes a standing answer, source ruling" {
  setup_docs decisions decisions
  export PE_RULINGS_FILE="$BATS_TEST_TMPDIR/rulings.ndjson"
  printf '%s\n' '{"version":1,"type":"ruling","id":"r-17","slug":"decisions","phase":2,"kind":"ambiguity","what":"read \"45m\" as the ceiling, not the estimate","at":"2026-09-14T00:00:00Z"}' > "$PE_RULINGS_FILE"
  run pe_decisions decisions promote --from-ruling r-17 --key waits --by op
  [ "$status" -eq 0 ]
  [ "$output" = "$(printf 'waits\tanswered\top\tyes\truling\tread "45m" as the ceiling, not the estimate')" ]
  grep -q '| ruling | ruling r-17 |' "$DOCS_ROOT/docs/handoffs/decisions/decisions.md"
  run pe_decisions decisions promote --from-ruling r-17 --by op
  [ "$status" -eq 2 ]
  assert_contains "$output" "carries no decisionKey"
  run pe_decisions decisions promote --from-ruling r-99 --key waits
  [ "$status" -eq 2 ]
  unset PE_RULINGS_FILE
}

@test "decisions.sh promote: an acked ruling is still found by its RULING line, and its own decisionKey names the row" {
  setup_docs decisions decisions
  export PE_RULINGS_FILE="$BATS_TEST_TMPDIR/rulings.ndjson"
  # The ack carries the same id and comes later; the row must not be written
  # from it (it has no `what`). The ruling's decisionKey stands in for --key.
  printf '%s\n' \
    '{"version":1,"type":"ruling","id":"aa11bb22cc33","slug":"decisions","phase":2,"kind":"ambiguity","what":"the window is the cap","decisionKey":"waits","at":"2026-09-14T00:00:00Z"}' \
    '{"version":1,"type":"ack","id":"aa11bb22cc33","at":"2026-09-14T00:01:00Z","by":"op"}' > "$PE_RULINGS_FILE"
  run pe_decisions decisions promote --from-ruling aa11bb22cc33 --by op
  [ "$status" -eq 0 ]
  [ "$output" = "$(printf 'waits\tanswered\top\tyes\truling\tthe window is the cap')" ]
  grep -q '| ruling | ruling aa11bb22cc33 |' "$DOCS_ROOT/docs/handoffs/decisions/decisions.md"
  unset PE_RULINGS_FILE
}

@test "decisions.sh: refusals — an unknown key, a phase the plan lacks, a missing value, a bad verb, a missing plan — write nothing" {
  setup_docs decisions decisions
  run pe_decisions decisions answer gate --value x;              [ "$status" -eq 2 ]; assert_contains "$output" "unknown decision key: gate"
  run pe_decisions decisions --phase 9 answer stop --value x;    [ "$status" -eq 2 ]; assert_contains "$output" "phase 9 is not in plan"
  run pe_decisions decisions answer stop;                        [ "$status" -eq 2 ]
  run pe_decisions decisions waive stop;                         [ "$status" -eq 2 ]
  run pe_decisions decisions decide stop --value x;              [ "$status" -eq 2 ]
  run pe_decisions decisions answer stop --value x --blocking maybe; [ "$status" -eq 2 ]
  [ ! -f "$DOCS_ROOT/docs/handoffs/decisions/decisions.md" ]
  run pe_decisions nosuch answer stop --value x;                 [ "$status" -eq 2 ]
}

@test "decisions.sh: a twin somebody hand-edited into a shape the engine reads differently is refused with exit 1, not silently" {
  setup_docs decisions decisions
  pe_decisions decisions answer stop --value "keep-going" --by op >/dev/null
  f="$DOCS_ROOT/docs/handoffs/decisions/decisions.md"
  # a second, hand-written row for the same key that the engine will read LAST
  printf '| `stop` | halt-on-everything | someone | answered | no | run | by hand | — |\n' >> "$f"
  run pe_decisions decisions answer stop --value "keep-going" --by op
  [ "$status" -eq 1 ]
  assert_contains "$output" "a row this script did not write"
}
