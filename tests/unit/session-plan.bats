#!/usr/bin/env bats
# Session budgets + batching. Budget VALUES must stay stable through F5 (single
# source) — only their storage location changes, not the numbers.
# v3 budgets: weight ≈ 0.2 × effective window (1M-class → 200K, Haiku/default → 40K).
# The session model (control-tower phase 59, #83): a session peaks at the floor
# (boot + work, paid once) plus a slope × its weight; the forecast is in the
# console's unit, 1 phase ≥ 1 session, from measured sessions per phase.
load ../helpers/test_helper

@test "session-plan: opus budget is ~200K" {
  setup_docs sizes sizes
  run pg sizes --session-plan opus
  assert_contains "$output" "~200K"
}

@test "session-plan: haiku budget is ~40K" {
  setup_docs sizes sizes
  run pg sizes --session-plan haiku
  assert_contains "$output" "~40K"
}

@test "session-plan: unknown/no model defaults to ~40K" {
  setup_docs sizes sizes
  run pg sizes --session-plan
  assert_contains "$output" "~40K"
}

@test "session-plan: no argument reads the plan's own Target model, as the board and the console do" {
  # plan-fields.ts: --session-plan reads **Target model:**. Unread, a 1M-window
  # plan was sized at the 40K default and the floor's warning called every
  # phase an overflow (control-tower phase 59).
  setup_docs sizes sizes
  printf '\n## Session budget\n\n**Target model:** `claude-opus-5-5[1m]`  ·  **Budget:** ~200K weight/session\n' >>"$DOCS_ROOT/docs/plans/sizes.md"
  run pg sizes --session-plan
  [ "$status" -eq 0 ]
  assert_contains "$output" "~200K"
  assert_contains "$output" "60 % of a 1M window"
  refute_contains "$output" "overflows"
  run pg sizes --session-plan haiku
  assert_contains "$output" "~40K"
}

@test "session-plan: a batch pays the session floor ONCE — 175K of weight is two sessions by hand, not one" {
  # sizes fixture: S+S+M+L+S = 175K. Under the old "context ≈ 3 × weight" it fit
  # one 200K session; measured, a session peaks at 319K + 2.17 × weight, so
  # 175K of weight is ~700K of context — past the 600K target (control-tower
  # phase 59, #83). The first three (70K → ~471K) share; the rest (105K) do.
  setup_docs sizes sizes
  run pg sizes --session-plan opus
  assert_contains "$output" "Session 1  batch  (~70K):  1 → 2 → 3"
  assert_contains "$output" "Session 2  batch  (~105K):  4 → 5"
  refute_contains "$output" "Session 3"
}

@test "session-plan: states its unit before anything else — 1 phase ≥ 1 session, the batches are a person's" {
  setup_docs sizes sizes
  run pg sizes --session-plan opus
  assert_contains "$output" "Unit: 1 phase ≥ 1 session — the console's autopilot boards every phase in a session of its own and never batches."
  assert_contains "$output" "By hand: remaining phases may share a session"
  # The unit line comes before the first session line.
  unit_line="$(printf '%s\n' "$output" | grep -n '^Unit:' | cut -d: -f1)"
  first_session="$(printf '%s\n' "$output" | grep -n 'Session 1 ' | cut -d: -f1)"
  [ "$unit_line" -lt "$first_session" ]
}

@test "session-plan: the forecast is measured sessions per phase, by size and wrap — never a weight over a budget" {
  # 3 S + 1 M + 1 L: (3 × 17117 + 16580 + 19252) / 10000 = 8.72 → ≈ 9 sessions,
  # where the weight over the 200K budget would have said one.
  setup_docs sizes sizes
  run pg sizes --session-plan opus
  assert_contains "$output" "Forecast: ≈ 9 sessions for 5 phases — sessions per phase, measured: S 1.7 (2.0 when it wraps, 7 % do) · M 1.5 (2.8, 15 %) · L 1.5 (2.5, 42 %)"
  # A done phase leaves the forecast (S: 1.71 → ≈ 7 for the four left).
  write_handoff sizes 1 first complete
  run pg sizes --session-plan opus
  assert_contains "$output" "Forecast: ≈ 7 sessions for 4 phases"
}

@test "session-plan: the weight sum is GENERATED — the whole plan and what is left, per size" {
  setup_docs sizes sizes
  run pg sizes --session-plan opus
  assert_contains "$output" "Weight: 1 L · 1 M · 3 S = 175K over 5 phases; left: 1 L · 1 M · 3 S = 175K over 5   (generated — quote it, never type a sum)"
  write_handoff sizes 4 big complete
  run pg sizes --session-plan opus
  assert_contains "$output" "left: 0 L · 1 M · 3 S = 85K over 4"
}

@test "session-plan: the boot floor is its own line, and a console's measured floor replaces the shipped one" {
  setup_docs sizes sizes
  run pg sizes --session-plan opus
  assert_contains "$output" "Boot floor: 121K per session — shipped default"
  assert_contains "$output" "Context: a session peaks near 319K + 2.17 × its weight (boot 121K + work 198K), sized to stay under 600K — 60 % of a 1M window"
  PE_BOOT_FLOOR=89000 PE_BOOT_FLOOR_SAMPLES=14 run pg sizes --session-plan opus
  assert_contains "$output" "Boot floor: 89K per session — the first call's context on this repository, measured over 14 sessions"
  assert_contains "$output" "peaks near 287K + 2.17 × its weight (boot 89K + work 198K)"
  # A garbage value is ignored, never arithmetic.
  PE_BOOT_FLOOR=lots run pg sizes --session-plan opus
  assert_contains "$output" "Boot floor: 121K per session — shipped default"
}

@test "session-plan: a budget whose target the floor alone reaches says so" {
  setup_docs sizes sizes
  run pg sizes --session-plan haiku
  assert_contains "$output" "the session floor alone (319K) reaches this budget's target (120K)"
}

@test "size weights: S=15K M=40K L=90K appear in the legend" {
  setup_docs sizes sizes
  run pg sizes --session-plan opus
  assert_contains "$output" "S=15K M=40K L=90K"
}

@test "session-plan: a '(1M window)' written after the Target model reads as [1m] (control-tower phase 13, #91)" {
  setup_docs sizes sizes
  printf '\n## Session budget\n\n**Target model:** `claude-opus-5-5` (1M window)  ·  **Budget:** ~200K weight/session\n' >>"$DOCS_ROOT/docs/plans/sizes.md"
  run pg sizes --session-plan
  [ "$status" -eq 0 ]
  assert_contains "$output" "~200K"
  assert_contains "$output" "60 % of a 1M window"
}
