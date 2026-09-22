#!/usr/bin/env bats
# The landing ledger — `scripts/phase-landing.sh` and the two gates that read it.
#
# The ledger exists so that "phase 8's work is actually on the branch I build
# on" stops being prose an operator has to confirm. Everything below is in
# service of one property: the gate's answer comes from a FILE, with no network
# and no `gh`, so a page view, a session and the autopilot cannot get three
# different answers to it — which is exactly what happened the last time a gate
# ran a command for some callers and declined for others.
load ../helpers/test_helper

landing_file() { printf '%s/docs/handoffs/%s/landing.md' "$DOCS_ROOT" "$1"; }
pe_landing() { DOCS_ROOT="${DOCS_ROOT:?}" "$SYS_BASH" "$PE_SCRIPTS/phase-landing.sh" "$@"; }

# --------------------------------------------------------------------------
# Writing
# --------------------------------------------------------------------------

@test "a first record creates the file, the heading and the header row" {
  setup_docs landing landing
  run pe_landing landing 4 pushed --ref pe/landing --sha deadbee
  [ "$status" -eq 0 ]
  [ -f "$(landing_file landing)" ]
  run cat "$(landing_file landing)"
  assert_contains "$output" "## Landings"
  assert_contains "$output" "| Phase |"
  assert_contains "$output" "pushed"
  assert_contains "$output" "deadbee"
}

@test "a second record for the same phase REPLACES the first — a ledger row is a position, not a log" {
  setup_docs landing landing
  pe_landing landing 4 pushed --ref pe/landing --sha aaa1111
  pe_landing landing 4 pr-open --pr https://github.com/o/r/pull/7 --sha aaa1111
  run pe_landing landing 4 pr-merged --pr https://github.com/o/r/pull/7 --sha bbb2222
  [ "$status" -eq 0 ]
  run pg landing --landing 4
  [ "$status" -eq 0 ]
  # One row, and it is the newest.
  [ "$(printf '%s\n' "$output" | grep -c .)" -eq 1 ]
  assert_contains "$output" "pr-merged"
  assert_contains "$output" "bbb2222"
  refute_contains "$output" "aaa1111"
}

@test "two REPOSITORIES of one phase are two rows — a mirror run lands N times" {
  setup_docs landing landing
  pe_landing landing 4 pushed --repo phased-execution --sha aaa1111
  run pe_landing landing 4 held --repo phase-console-site
  [ "$status" -eq 0 ]
  run pg landing --landing 4
  [ "$(printf '%s\n' "$output" | grep -c .)" -eq 2 ]
  assert_contains "$output" "phased-execution"
  assert_contains "$output" "phase-console-site"
}

@test "--repo '' names the ROOT — the key the landing prompt writes for a plain repository or a mounted superproject" {
  # The prompt's own row line spells every key the same way, `--repo '<key>'`,
  # and the root's key is the empty string. A script that refused it would
  # hand a landing session a command that fails when run verbatim.
  setup_docs landing landing
  pe_landing landing 4 pushed --repo phased-execution --sha aaa1111
  run pe_landing landing 4 pr-open --repo '' --ref pe/demo --pr https://github.com/o/r/pull/7
  [ "$status" -eq 0 ]
  run pg landing --landing 4
  [ "$(printf '%s\n' "$output" | grep -c .)" -eq 2 ]
  assert_contains "$output" "pr-open"
  # …and the same row again without the flag is the same row, not a third.
  run pe_landing landing 4 pr-open --ref pe/demo --pr https://github.com/o/r/pull/7
  [ "$status" -eq 0 ]
  run pg landing --landing 4
  [ "$(printf '%s\n' "$output" | grep -c .)" -eq 2 ]
}

@test "an unknown state is refused, not written" {
  setup_docs landing landing
  run pe_landing landing 4 nearly-there
  [ "$status" -eq 2 ]
  assert_contains "$output" "nearly-there"
  [ ! -f "$(landing_file landing)" ]
}

@test "a phase this plan does not have is refused" {
  setup_docs landing landing
  run pe_landing landing 99 pushed
  [ "$status" -eq 2 ]
  assert_contains "$output" "99"
}

@test "writing is idempotent — the same record twice leaves one row and one file" {
  setup_docs landing landing
  pe_landing landing 4 pr-merged --pr https://github.com/o/r/pull/7 --sha bbb2222
  local before after
  before="$(cat "$(landing_file landing)")"
  pe_landing landing 4 pr-merged --pr https://github.com/o/r/pull/7 --sha bbb2222
  after="$(cat "$(landing_file landing)")"
  # `recorded` is a timestamp, so compare everything else.
  [ "$(printf '%s' "$before" | grep -c '^|')" = "$(printf '%s' "$after" | grep -c '^|')" ]
  run pg landing --landing 4
  [ "$(printf '%s\n' "$output" | grep -c .)" -eq 1 ]
}

@test "a note with a pipe in it cannot break the table" {
  setup_docs landing landing
  run pe_landing landing 4 failed --note 'git said: a | b'
  [ "$status" -eq 0 ]
  run pg landing --landing 4
  [ "$status" -eq 0 ]
  [ "$(printf '%s\n' "$output" | grep -c .)" -eq 1 ]
  # The state must still be readable in column 3, which is the whole risk.
  [ "$(printf '%s\n' "$output" | cut -f3)" = "failed" ]
}

@test "list prints every row, and list N only that phase's" {
  setup_docs landing landing
  pe_landing landing 2 integrated
  pe_landing landing 4 pr-merged --pr https://github.com/o/r/pull/7
  run pe_landing landing list
  [ "$status" -eq 0 ]
  assert_contains "$output" "integrated"
  assert_contains "$output" "pr-merged"
  run pe_landing landing list 2
  assert_contains "$output" "integrated"
  refute_contains "$output" "pr-merged"
}

# --------------------------------------------------------------------------
# Reading — the engine's own arm
# --------------------------------------------------------------------------

@test "--landing on a phase with no record says nothing, and exits 0" {
  setup_docs landing landing
  run pg landing --landing 4
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "--landing reads its columns BY NAME, so an added column cannot shift the state" {
  setup_docs landing landing
  mkdir -p "$DOCS_ROOT/docs/handoffs/landing"
  cat > "$(landing_file landing)" <<'LEDGER'
# Landings — landing

## Landings

| Note | Phase | State | Policy | Ref | SHA | PR | By | Recorded |
|---|---:|---|---|---|---|---|---|---|
| moved early | 4 | pr-merged | pr | pe/landing | bbb2222 | https://github.com/o/r/pull/7 | somebody | 2026-09-18 |
LEDGER
  run pg landing --landing 4
  [ "$status" -eq 0 ]
  # Column 1 of the TSV is always the phase and column 3 always the state,
  # whatever order the file happens to be in.
  [ "$(printf '%s' "$output" | cut -f1)" = "4" ]
  [ "$(printf '%s' "$output" | cut -f3)" = "pr-merged" ]
}

# --------------------------------------------------------------------------
# The gates
# --------------------------------------------------------------------------

@test "landed N: blocked before any record, naming the policy it is waiting for" {
  setup_docs landing landing
  run pg landing --gate-status 5
  [ "$status" -eq 1 ]
  [ "$output" = "blocked: phase 4 has no landing record yet (policy trunk)" ]
}

@test "landed N: clear once the ledger says the policy's own end state" {
  setup_docs landing landing
  pe_landing landing 4 landed --sha bbb2222
  run pg landing --gate-status 5
  [ "$status" -eq 0 ]
  [ "$output" = "clear (phase 4 landed: landed)" ]
}

@test "landed N: a record short of the policy's end state is still blocked, and says how far it got" {
  setup_docs landing landing
  pe_landing landing 4 pushed --sha bbb2222
  run pg landing --gate-status 5
  [ "$status" -eq 1 ]
  assert_contains "$output" "phase 4 is pushed"
  assert_contains "$output" "trunk"
}

@test "landed N: a hold phase lands by being held — the gate must not wait for ever" {
  setup_docs landing landing
  # Phase 3's policy is `hold`, whose end state is `held`. A gate on it clears
  # the moment the ledger records that nothing is going to move, which is a
  # real answer and not an absence of one.
  pe_landing landing 3 held --note 'a person merges this one'
  run pg landing --gate-kind 5
  [ "$output" = "auto" ]
  DOCS_ROOT="$DOCS_ROOT" "$SYS_BASH" "$PE_SCRIPTS/phase-landing.sh" landing 4 landed
  run pg landing --gate-status 5
  [ "$status" -eq 0 ]
}

@test "pr-merged N: only a merged pull request clears it, whatever the policy says" {
  setup_docs landing landing
  # Rewrite phase 5's gate to the other kind.
  perl -pi -e 's/^- \*\*Gate-check:\*\* landed 4$/- **Gate-check:** pr-merged 4/' "$DOCS_ROOT/docs/plans/landing.md"
  pe_landing landing 4 landed --sha bbb2222
  run pg landing --gate-status 5
  [ "$status" -eq 1 ]
  assert_contains "$output" "not merged"
  pe_landing landing 4 pr-merged --pr https://github.com/o/r/pull/7 --sha bbb2222
  run pg landing --gate-status 5
  [ "$status" -eq 0 ]
  [ "$output" = "clear (phase 4 landed: pr-merged)" ]
}

@test "a recorded APPROVAL clears a landing gate, like every other kind" {
  setup_docs landing landing
  gate_approve landing 5 --by operator --note 'merged by hand while CI was down'
  run pg landing --gate-status 5
  [ "$status" -eq 0 ]
  assert_contains "$output" "approved by operator"
}

@test "the gate answers identically with and without PHASE_EXEC_GATES — it runs nothing" {
  setup_docs landing landing
  pe_landing landing 4 landed
  run pg landing --gate-status 5
  local plain="$output"
  PHASE_EXEC_GATES=1 run pg landing --gate-status 5
  [ "$output" = "$plain" ]
}
