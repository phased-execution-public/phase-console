#!/usr/bin/env bats
# `--verify-in N` — the directory phase N's §Verification commands mean, read
# off its `**Verify in:**` bullet: one line, the value with bold and backticks
# stripped (as `--checkout` strips them), an empty line for a phase without
# one, and a usage error (exit 2) with no phase at all.
#
# The reader is held to the console's own, `bullet(labelledBullets(block),
# 'Verify in')` in viewer/server/parse/plan.ts, because the two answer one
# question — where the console judges a phase's lines — and
# `phase-outcome.sh verified` asks this one: the label is BOLD (an unbolded
# line is not a field to either), matched case-insensitively by prefix, at
# either indent (a top-level bullet, or nested under `- **Verification:**`),
# first in document order, never inside a fenced block. Lint F39 reads the
# directory through the same reader.
load ../helpers/test_helper

vin_docs() {
  setup_docs setup-bullet vin
  cat > "$DOCS_ROOT/docs/plans/vin.md" <<'EOF'
---
slug: vin
status: active
phases: 9
---

# Verify in — fixture

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|---|---|---|---|---|---|
| 1 | Top-level bullet | — | — | app | x |
| 2 | Nested bullet | — | — | app | x |
| 3 | No bullet | — | — | app | x |
| 4 | Backticked value | — | — | app | x |
| 5 | Unbolded label | — | — | app | x |
| 6 | A fenced example first | — | — | app | x |
| 7 | Lower-case label, padded value | — | — | app | x |
| 8 | Two bullets | — | — | app | x |
| 9 | Colon outside the bold | — | — | app | x |

### Phase 1 — Top-level bullet
- **Verify in:** phased-execution
- **Verification:**
  - `npm test`

### Phase 2 — Nested bullet
- **Verification:**
  - **Verify in:** services/api
  - `npm test`

### Phase 3 — No bullet
- **Verification:**
  - `true`

### Phase 4 — Backticked value
- **Verification:**
  - **Verify in:** `app/app-backend`
  - `npm test`

### Phase 5 — Unbolded label
- Verify in: services/api
- **Verification:**
  - `true`

### Phase 6 — A fenced example first
- **Goal:** document the bullet, which reads like this:
  ```
  - **Verify in:** not/this
  ```
- **Verification:**
  - **Verify in:** services/web
  - `true`

### Phase 7 — Lower-case label, padded value
- **verify in:**   phase-console-site
- **Verification:**
  - `true`

### Phase 8 — Two bullets
- **Verify in:** first
- **Verification:**
  - **Verify in:** second
  - `true`

### Phase 9 — Colon outside the bold
- **Verify in**: outside
- **Verification:**
  - `true`
EOF
}

@test "--verify-in N: a top-level bullet's value, one line" {
  vin_docs
  run pg vin --verify-in 1
  [ "$status" -eq 0 ]
  [ "$output" = "phased-execution" ]
  [ "${#lines[@]}" -eq 1 ]
}

@test "--verify-in N: a bullet nested under Verification is read too" {
  vin_docs
  run pg vin --verify-in 2
  [ "$status" -eq 0 ]
  [ "$output" = "services/api" ]
}

@test "--verify-in N: a phase without the bullet answers an empty line, status 0" {
  vin_docs
  run pg vin --verify-in 3
  [ "$status" -eq 0 ]
  [ "$output" = "" ]
  # Exactly one (empty) line, so a reader can `read` it under `set -e`.
  [ "$(pg vin --verify-in 3 | wc -l | tr -d ' ')" = "1" ]
}

@test "--verify-in N: backticks and bold are stripped from the value" {
  vin_docs
  run pg vin --verify-in 4
  [ "$status" -eq 0 ]
  [ "$output" = "app/app-backend" ]
}

@test "--verify-in N: an unbolded line is not the field (the console's reader requires the bold)" {
  vin_docs
  run pg vin --verify-in 5
  [ "$status" -eq 0 ]
  [ "$output" = "" ]
}

@test "--verify-in N: a bullet inside a fenced block is an example, not the field" {
  vin_docs
  run pg vin --verify-in 6
  [ "$status" -eq 0 ]
  [ "$output" = "services/web" ]
}

@test "--verify-in N: the label is case-insensitive and the value trimmed" {
  vin_docs
  run pg vin --verify-in 7
  [ "$status" -eq 0 ]
  [ "$output" = "phase-console-site" ]
}

@test "--verify-in N: the first bullet in document order wins" {
  vin_docs
  run pg vin --verify-in 8
  [ "$status" -eq 0 ]
  [ "$output" = "first" ]
}

@test "--verify-in N: a colon outside the bold reads the same" {
  vin_docs
  run pg vin --verify-in 9
  [ "$status" -eq 0 ]
  [ "$output" = "outside" ]
}

@test "--verify-in N: a neighbour phase never lends its bullet" {
  vin_docs
  # Phase 3 sits between two phases that declare one.
  run pg vin --verify-in 3
  [[ "$output" != *"services"* ]]
  [[ "$output" != *"phased-execution"* ]]
}

@test "--verify-in N: a zero-padded phase answers about the same phase" {
  vin_docs
  run pg vin --verify-in 02
  [ "$status" -eq 0 ]
  [ "$output" = "services/api" ]
}

@test "--verify-in N: a phase the plan does not have answers an empty line" {
  vin_docs
  run pg vin --verify-in 99
  [ "$status" -eq 0 ]
  [ "$output" = "" ]
}

@test "--verify-in: a phase number is required" {
  vin_docs
  run pg vin --verify-in
  [ "$status" -eq 2 ]
  assert_contains "$output" "usage: --verify-in <phase>"
}
