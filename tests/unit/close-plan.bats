#!/usr/bin/env bats
# close-plan.sh — the stored decision "does anyone still care?", and what it may
# do to the locks the plan left behind.
load ../helpers/test_helper

setup() { unset PE_SESSION_ID CLAUDE_CODE_SESSION_ID PE_BRANCH PE_WORKTREE; }

# ── LCK-4 — closing a plan swept LIVE leases ─────────────────────────────────
# A closed plan must not gate live work — `conflicts` scans every plan, so a
# dead plan's leftover lock would collide with sessions on other plans. But the
# sweep was unconditional, and a lease that has NOT passed is not debris: it is
# a session editing a working tree right now. Removing it lets another plan
# admit into that tree under it, which is the exact failure the lock exists for.
@test "close-plan: a live lease is kept and named, not swept (LCK-4)" {
  setup_docs linear linear
  pe_lock linear claim 1 --owner sessionA
  run pe_close linear --status abandoned --reason "done with it"
  [ "$status" -eq 0 ]
  [ -f "$DOCS_ROOT/docs/handoffs/linear/.locks/phase-01.lock" ]
  assert_contains "$output" "phase 1"
  assert_contains "$output" "sessionA"
}

@test "close-plan: an EXPIRED lease is still swept without --force (LCK-4)" {
  setup_docs linear linear
  pe_lock linear claim 1 --owner sessionA
  expire_lock linear 1
  run pe_close linear --status abandoned --reason "done with it"
  [ "$status" -eq 0 ]
  [ ! -f "$DOCS_ROOT/docs/handoffs/linear/.locks/phase-01.lock" ]
  assert_contains "$output" "released 1"
}

@test "close-plan: --force sweeps a live lease (LCK-4)" {
  setup_docs linear linear
  pe_lock linear claim 1 --owner sessionA
  run pe_close linear --status abandoned --force
  [ "$status" -eq 0 ]
  [ ! -f "$DOCS_ROOT/docs/handoffs/linear/.locks/phase-01.lock" ]
  assert_contains "$output" "released 1"
}

@test "close-plan: a live lease and an expired one — one kept, one released (LCK-4)" {
  setup_docs linear linear
  pe_lock linear claim 1 --owner sessionA
  pe_lock linear claim 2 --owner sessionB
  expire_lock linear 2
  run pe_close linear --status abandoned --reason "done with it"
  [ "$status" -eq 0 ]
  [ -f "$DOCS_ROOT/docs/handoffs/linear/.locks/phase-01.lock" ]
  [ ! -f "$DOCS_ROOT/docs/handoffs/linear/.locks/phase-02.lock" ]
  assert_contains "$output" "released 1"
}

@test "close-plan: --reopen never touches a lock" {
  setup_docs linear linear
  pe_lock linear claim 1 --owner sessionA
  pe_close linear --status abandoned --force
  pe_lock linear claim 1 --owner sessionA
  run pe_close linear --reopen
  [ "$status" -eq 0 ]
  [ -f "$DOCS_ROOT/docs/handoffs/linear/.locks/phase-01.lock" ]
}
