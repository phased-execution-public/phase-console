#!/usr/bin/env bats
# The lints measured-console phase 2 adds — F50 `directive-mid-line`, F51
# `path-no-dir`, F52 `verification-shared-checkout` — and the engine's one
# locale (#410). All three are ADVISORY: named on stderr, the exit untouched.
load ../helpers/test_helper

# --------------------------------------------------------------------------
# F50 directive-mid-line (#419)
# --------------------------------------------------------------------------

@test "F50: a label after prose in §Session budget is named; one after ' · ' is read, never named" {
  setup_docs directive-mid-line directive-mid-line
  run pg directive-mid-line --lint
  [ "$status" -eq 0 ]
  assert_contains "$output" 'F50 §Session budget: directive-mid-line — `**Conflicts:**` sits mid-line'
  for read in "Verify timeout" "Wait count" "Gitlink" "Issues" "Messaging"; do
    refute_contains "$output" "\`**$read:**\` sits mid-line, where"
  done
}

@test "F50: a second label inside a phase's bullet is named, and a backticked label is prose" {
  setup_docs directive-mid-line directive-mid-line
  run pg directive-mid-line --lint
  assert_contains "$output" 'F50 phase 2: directive-mid-line — `**Verify timeout:**` sits mid-line in a bullet'
  refute_contains "$output" "F50 phase 3"
  refute_contains "$output" '`**Landing:**`'
}

@test "F50: the readers it describes really do miss what it names" {
  setup_docs directive-mid-line directive-mid-line
  # phase 2's mid-line bullet is silence, so the plan's line answers
  run pg directive-mid-line --verify-timeout 2
  [ "$output" = "$(printf '90\tplan')" ]
  run pg directive-mid-line --conflict-policy
  [ "$output" = "$(printf 'halt\tdefault')" ]
}

# --------------------------------------------------------------------------
# F51 path-no-dir (#402)
# --------------------------------------------------------------------------

@test "F51: a Repos token and a Verify in: path that name no directory under the root are named" {
  setup_docs path-no-dir path-no-dir
  mkdir -p "$DOCS_ROOT/app"
  run pg path-no-dir --lint
  [ "$status" -eq 0 ]
  assert_contains "$output" 'F51 phase 2: path-no-dir — the Repos cell names `nowhere`'
  assert_contains "$output" 'F51 phase 3: path-no-dir — `Verify in: app/missing` is no directory'
  refute_contains "$output" "F51 phase 1"
}

@test "F51: the hub shape — no token under the root at all — names no Repos token" {
  setup_docs path-no-dir path-no-dir
  run pg path-no-dir --lint
  refute_contains "$output" "the Repos cell names"
}

@test "F51: a submodule path, the root's own name and all are directories enough" {
  setup_docs path-no-dir path-no-dir
  mkdir -p "$DOCS_ROOT/app" "$DOCS_ROOT/nowhere"
  run pg path-no-dir --lint
  refute_contains "$output" 'the Repos cell names `nowhere`'
}

# --------------------------------------------------------------------------
# F52 verification-shared-checkout (#423)
# --------------------------------------------------------------------------

_shared_plan() {  # _shared_plan <verification line>
  scrub_pe_env
  export DOCS_ROOT="$BATS_TEST_TMPDIR/work"
  mkdir -p "$DOCS_ROOT/docs/plans" "$DOCS_ROOT/apps/web" "$DOCS_ROOT/apps/api"
  cat > "$DOCS_ROOT/docs/plans/shared.md" <<PLAN
---
slug: shared
created: 2026-10-25
status: active
phases: 1
---

# Shared checkout

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | Alpha | — | — | apps/web, apps/api | builds |

## Phases

### Phase 1 — Alpha
- **Verification:**
  - **Verify in:** apps/web
  - \`$1\`
PLAN
}

@test "F52: a Verification line that cds into the shared checkout's absolute path is named, with its relative form" {
  _shared_plan "cd $BATS_TEST_TMPDIR/work/apps/api && true"
  run pg shared --lint
  [ "$status" -eq 0 ]
  assert_contains "$output" "F52 phase 1: verification-shared-checkout"
  assert_contains "$output" '`../../apps/api`'
}

@test "F52: the relative form is not named, nor an absolute path outside the root" {
  _shared_plan "cd ../api && true"
  run pg shared --lint
  refute_contains "$output" "F52"
  _shared_plan "cd /tmp && true"
  run pg shared --lint
  refute_contains "$output" "F52"
}

@test "F52: git -C and npm --prefix into the shared checkout are named too" {
  _shared_plan "git -C $BATS_TEST_TMPDIR/work/apps/api status"
  run pg shared --lint
  assert_contains "$output" "F52 phase 1: verification-shared-checkout"
  _shared_plan "npm --prefix $BATS_TEST_TMPDIR/work/apps/api test"
  run pg shared --lint
  assert_contains "$output" "F52 phase 1: verification-shared-checkout"
}

# --------------------------------------------------------------------------
# F49 amendment-malformed (measured-console phase 30) — ADVISORY
# --------------------------------------------------------------------------

@test "F49: a phase's Amendment with no matching note, and a note naming a phase the plan lacks, are both named" {
  setup_docs amendment-orphans amendment-orphans
  run pg amendment-orphans --lint
  [ "$status" -eq 0 ]   # advisory: the exit is untouched
  assert_contains "$output" 'F49 phase 1: amendment-malformed — it carries "Amendment: 2"'
  assert_contains "$output" 'F49 amendment 1: amendment-malformed — its note names phase 9, which this plan does not have'
}

@test "F49: a note that opens *(Amendment and is not the shape, and one that names nothing a phase carries, are named" {
  setup_docs amendment-orphans amendment-orphans
  run pg amendment-orphans --lint
  assert_contains "$output" 'F49 amendment: amendment-malformed — "> *(Amendment 3 2026-10-28)*'
  assert_contains "$output" 'F49 amendment 4: amendment-malformed — its note names no phase and no phase carries "Amendment: 4"'
}

@test "F49: a well-formed amendment — the bullet and its note — is not named" {
  setup_docs amended amended
  run pg amended --lint
  refute_contains "$output" "F49"
}

@test "F49: amend-plan.sh's own output is clean, and a plan with no amendments says nothing" {
  setup_docs amendable amendable
  run pe_amend amendable --title "Gamma" --size S --repos repoA --depends 2
  [ "$status" -eq 0 ]
  run pg amendable --lint
  refute_contains "$output" "F49"
  setup_docs linear linear
  run pg linear --lint
  refute_contains "$output" "F49"
}

@test "F49: it has a paragraph, and is an advisory" {
  scrub_pe_env
  export DOCS_ROOT="$BATS_TEST_TMPDIR/empty"; mkdir -p "$DOCS_ROOT"
  run pg --explain F49
  [ "$status" -eq 0 ]
  assert_contains "${lines[0]}" "F49 amendment-malformed (advisory)"
}

# --------------------------------------------------------------------------
# #416 engine half — a gated row whose section is not written fails closed
# --------------------------------------------------------------------------

@test "#416: a GATED row with no section reads human and 'manual: …not written yet', never the ai default" {
  setup_docs amended amended
  run pg amended --gate-kind 4
  [ "$output" = "human" ]
  run pg amended --gate-status 4
  [ "$status" -eq 1 ]
  assert_contains "$output" "manual: phase 4's section is not written yet"
}

@test "#416: a gated phase WITH a section and no directive keeps the ai default (F24 names it)" {
  setup_docs bad-gated-no-check x
  run pg x --gate-kind 2
  [ "$output" = "ai" ]
  run pg x --lint
  assert_contains "$output" "gate-directive-missing"
}

# --------------------------------------------------------------------------
# --out-of-scope and --not-yet-specified (measured-console phase 30)
# --------------------------------------------------------------------------

@test "--out-of-scope: the bullet and its continuation lines, one trimmed line each; nothing when absent" {
  setup_docs amended amended
  run pg amended --out-of-scope 1
  [ "$status" -eq 0 ]
  [ "$output" = "the payment rail." ]
  run pg amended --out-of-scope 2
  [ "$output" = "$(printf 'the queue screens\n- nothing under `client/`\nthe release scripts')" ]
  run pg amended --out-of-scope 3
  [ "$status" -eq 0 ]
  [ -z "$output" ]
  run pg amended --out-of-scope
  [ "$status" -eq 2 ]
}

@test "--not-yet-specified: the section's non-empty lines; nothing when empty or absent" {
  setup_docs amended amended
  run pg amended --not-yet-specified
  [ "$status" -eq 0 ]
  [ "$output" = "$(printf -- "- Phase 3's exit criteria are a placeholder.\n-   the retry policy for Gamma")" ]
  setup_docs linear linear
  run pg linear --not-yet-specified
  [ "$status" -eq 0 ]
  [ -z "$output" ]
  printf '\n## Not yet specified\n\n' >> "$DOCS_ROOT/docs/plans/linear.md"
  run pg linear --not-yet-specified
  [ -z "$output" ]
}

# --------------------------------------------------------------------------
# One locale (#410)
# --------------------------------------------------------------------------

_under() {  # _under <locale assignment> <args…> — the engine under one locale, stderr folded
  local loc="$1"; shift
  env -u LC_ALL -u LANG -u LC_CTYPE "$loc" DOCS_ROOT="$DOCS_ROOT" "$SYS_BASH" "$PE_SCRIPTS/phase-graph.sh" "$@" 2>&1
}

@test "locale: the nbsp fixture reads the same under LANG=C and LC_ALL=en_US.UTF-8, mode by mode" {
  setup_docs nbsp-fence nbsp-fence
  for args in "--memory-block" "--lint" "--verify-timeout 1" "--model-policy 2" "--size 1" "--decisions" "--section 1"; do
    # shellcheck disable=SC2086
    c="$(_under LANG=C nbsp-fence $args)"
    # shellcheck disable=SC2086
    u="$(_under LC_ALL=en_US.UTF-8 nbsp-fence $args)"
    [ "$c" = "$u" ] || { echo "$args differs by locale:"; diff <(printf '%s\n' "$c") <(printf '%s\n' "$u"); false; }
  done
}

@test "locale: a label joined by a no-break space is text, as CommonMark and the JS readers read it" {
  setup_docs nbsp-fence nbsp-fence
  run _under LC_ALL=en_US.UTF-8 nbsp-fence --verify-timeout 1
  [ -z "$output" ]
  run _under LC_ALL=en_US.UTF-8 nbsp-fence --model-policy 2
  [ -z "$output" ]
}
