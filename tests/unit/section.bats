#!/usr/bin/env bats
# `--section N` (measured-console phase 2): what a session reads of the plan.
#
# A session used to read the whole plan — or grep it — to find its own phase,
# and a 3,500-line plan is ~100K tokens paid for one section. The mode prints
# the `### Phase N` section verbatim, its graph row under the table's header,
# and the §Session budget directives that bind it, and nothing of any other
# phase. The skill's mode files and the SessionStart brief are written against
# this exact shape, so the first test pins it byte for byte.
load ../helpers/test_helper

@test "--section: the section verbatim, its graph row, the binding budget lines — the exact shape" {
  setup_docs section section
  run pg section --section 2
  [ "$status" -eq 0 ]
  expected="$(cat <<'EOF'
### Phase 2 — The one read whole
- **Goal:** the section, verbatim — its bullets, its nested bullets, its fence.
- **Size:** M
- **Model:** claude-opus-5-5[1m]
- **Verify timeout:** 90m
- **Steps:**
  1. one
  2. two

#### A sub-heading stays inside the section

```text
a fenced line stays inside the section, verbatim
```
- **Verification:**
  - **Verify in:** r
  - `true`

## Phase graph — phase 2's row
| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 2 | The one read whole | 1 | — | r | `--section` works |

## Session budget — the lines that bind phase 2
**Budget:** ~200K weight/session
**Branch:** `pe/section`, cut at launch from the checkout's
head; this line continues the branch directive.
**QA gate:** off
**Wait budget:** 10h
**Issues:** file
**Driver:** the console's autopilot; a label that opens a line after prose
is a directive again.
EOF
)"
  [ "$output" = "$expected" ] || { diff <(printf '%s\n' "$expected") <(printf '%s\n' "$output") >&2; false; }
}

@test "--section: nothing of another phase, the plan's prose or a later section" {
  setup_docs section section
  run pg section --section 2
  [ "$status" -eq 0 ]
  refute_contains "$output" "Phase 1 — Before"
  refute_contains "$output" "Phase 3 — After"
  refute_contains "$output" "| 1 | Before"
  refute_contains "$output" "| 3 | After"
  refute_contains "$output" "End-to-end"
  refute_contains "$output" "Prose the section must never carry"
}

@test "--section: a directive the phase states itself is not repeated from the budget — Model: overrides Target model:" {
  setup_docs section section
  run pg section --section 2
  refute_contains "$output" "Target model"
  refute_contains "$output" "**Verify timeout:** 60m"
  # Phase 1 states neither, so both bind it.
  run pg section --section 1
  assert_contains "$output" '**Target model:** `claude-opus-5` (1M window)'
  assert_contains "$output" "**Verify timeout:** 60m"
}

@test "--section: a §Session budget paragraph that opens with no bold label is prose and is left out" {
  setup_docs section section
  run pg section --section 1
  refute_contains "$output" "A paragraph that opens with no bold label"
  refute_contains "$output" "when it mentions"
}

@test "--section: a padded number reads as the phase, an unknown one is refused by name" {
  setup_docs section section
  run pg section --section 02
  [ "$status" -eq 0 ]
  assert_contains "$output" "### Phase 2 — The one read whole"
  run pg section --section 9
  [ "$status" -eq 2 ]
  assert_contains "$output" "phase 9 is not in this plan"
  run pg section --section
  [ "$status" -eq 2 ]
}

@test "--section: the last phase ends at the next ## heading" {
  setup_docs section section
  run pg section --section 3
  [ "$status" -eq 0 ]
  assert_contains "$output" '  - `false`'
  refute_contains "$output" "Nothing of this reaches"
}
