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

# ── #320 — `complete` is checked: the work landed, nothing of the plan's left open ──
# The regression of #184: a plan closed `complete` ten minutes after its run
# settled with its branch off origin/main, and its own acceptance defects open.

# A docs root that is a git repository with an origin, its plan's run branch cut.
landed_root() {
  setup_docs linear linear
  git -C "$DOCS_ROOT" init -q
  git -C "$DOCS_ROOT" checkout -q -b main
  git -C "$DOCS_ROOT" config user.email t@t.t
  git -C "$DOCS_ROOT" config user.name t
  git -C "$DOCS_ROOT" add -A
  git -C "$DOCS_ROOT" commit -qm base
  git init -q --bare "$BATS_TEST_TMPDIR/origin.git"
  git -C "$DOCS_ROOT" remote add origin "$BATS_TEST_TMPDIR/origin.git"
  git -C "$DOCS_ROOT" push -q origin main
  git -C "$DOCS_ROOT" checkout -q -b pe/linear
  echo work > "$DOCS_ROOT/work.txt"
  git -C "$DOCS_ROOT" add work.txt
  git -C "$DOCS_ROOT" commit -qm "the plan's work"
  git -C "$DOCS_ROOT" checkout -q main
}

@test "close-plan: complete is refused while pe/<slug> is not on origin's trunk, naming it (#320)" {
  landed_root
  run pe_close linear --status complete --reason "shipped"
  [ "$status" -eq 1 ]
  assert_contains "$output" "refusing to close linear complete"
  assert_contains "$output" "pe/linear in the root is not on origin/main"
  run grep -c '^status: complete' "$DOCS_ROOT/docs/plans/linear.md"
  [ "$output" = 0 ]
}

@test "close-plan: complete closes once the branch is merged — or squashed — onto origin's trunk (#320)" {
  landed_root
  git -C "$DOCS_ROOT" merge -q --squash pe/linear
  git -C "$DOCS_ROOT" commit -qm "squash: the plan's work"
  git -C "$DOCS_ROOT" push -q origin main
  run pe_close linear --status complete --reason "shipped"
  [ "$status" -eq 0 ]
  assert_contains "$output" "closed: linear = complete"
  grep -q '^status: complete' "$DOCS_ROOT/docs/plans/linear.md"
}

@test "close-plan: a landing row in conflict refuses complete (#320)" {
  landed_root
  git -C "$DOCS_ROOT" merge -q pe/linear
  git -C "$DOCS_ROOT" push -q origin main
  mkdir -p "$DOCS_ROOT/docs/handoffs/linear"
  printf '# Landings — linear\n\n## Landings\n\n| Phase | Repo | State | Policy | Ref | SHA | PR | By | Recorded | Note |\n|------:|------|-------|--------|-----|-----|----|----|----------|------|\n| 2 | - | conflict | integrate | pe/linear | - | - | x | 2026-10-18T00:00:00Z | - |\n' \
    > "$DOCS_ROOT/docs/handoffs/linear/landing.md"
  run pe_close linear --status complete --reason "shipped"
  [ "$status" -eq 1 ]
  assert_contains "$output" "landing: phase 2 in the root is conflict"
}

@test "close-plan: an open plan:<slug> issue refuses complete, and --force closes over it and says so (#320)" {
  landed_root
  git -C "$DOCS_ROOT" merge -q pe/linear
  git -C "$DOCS_ROOT" push -q origin main
  git -C "$DOCS_ROOT" remote set-url origin https://github.com/acme/widgets.git
  mkdir -p "$BATS_TEST_TMPDIR/bin"
  printf '#!/bin/sh\necho "$*" >> "%s/gh.args"\necho "#363 the acceptance found this"\n' "$BATS_TEST_TMPDIR" > "$BATS_TEST_TMPDIR/bin/gh"
  chmod +x "$BATS_TEST_TMPDIR/bin/gh"
  PATH="$BATS_TEST_TMPDIR/bin:$PATH" run pe_close linear --status complete --reason "shipped"
  [ "$status" -eq 1 ]
  assert_contains "$output" "open: acme/widgets #363 the acceptance found this"
  assert_contains "$(cat "$BATS_TEST_TMPDIR/gh.args")" "-R acme/widgets --label plan:linear --state open"
  PATH="$BATS_TEST_TMPDIR/bin:$PATH" run pe_close linear --status complete --reason "shipped" --force
  [ "$status" -eq 0 ]
  assert_contains "$output" "--force: closed complete over what is still open"
  grep -q '^status: complete' "$DOCS_ROOT/docs/plans/linear.md"
  grep -q '^closed_reason: shipped — closed complete with 1 item(s) open (--force)' "$DOCS_ROOT/docs/plans/linear.md"
}

@test "close-plan: abandoned and superseded are never held to the landing (#320)" {
  landed_root
  run pe_close linear --status abandoned --reason "nobody needs it"
  [ "$status" -eq 0 ]
  grep -q '^status: abandoned' "$DOCS_ROOT/docs/plans/linear.md"
}

# ── the plan's memory is history (measured-console phase 4) ──────────────────
# `docs/memory/<slug>/index.md` holds dated, commit-cited claims; closing names
# each claim that carries neither a date nor a commit, by line, and refuses nothing.
@test "close-plan: an undated claim in the plan's memory is named by line; dated and commit-cited ones are not" {
  setup_docs linear linear
  mkdir -p "$DOCS_ROOT/docs/memory/linear"
  cat > "$DOCS_ROOT/docs/memory/linear/index.md" <<'EOF'
# linear — memory

- 2026-10-25 (phase 1): the floor measured at 111,210 tokens
- the brief replaces the prompt's rows (phase 4, `1a2b3c4d`)
- the hook waits 15 s at SessionStart
- a claim whose date sits on its
  continuation line, 2026-10-24
EOF
  run pe_close linear --status abandoned --reason "done with it"
  [ "$status" -eq 0 ]
  assert_contains "$output" "memory: 1 claim(s) in docs/memory/linear/index.md carry no date and no commit"
  assert_contains "$output" "index.md:5  the hook waits 15 s at SessionStart"
  refute_contains "$output" "index.md:3"
  refute_contains "$output" "index.md:4"
  refute_contains "$output" "index.md:6"
}

@test "close-plan: a plan with no memory, or a memory all dated, says nothing about it" {
  setup_docs linear linear
  run pe_close linear --status abandoned --reason "done with it"
  [ "$status" -eq 0 ]
  refute_contains "$output" "memory:"
}

# ── Not yet specified (measured-console phase 30) ───────────────────────────
# `complete` is a claim that nothing is missing; the plan's own list of what is
# missing refuses it, and --force does not close over that.
@test "close-plan: complete is refused while ## Not yet specified holds a line, naming the section" {
  setup_docs amended amended
  run pe_close amended --status complete --reason "all done"
  [ "$status" -eq 1 ]
  assert_contains "$output" "Not yet specified"
  assert_contains "$output" "the retry policy for Gamma"
  grep -q '^status: active' "$DOCS_ROOT/docs/plans/amended.md"
  run pe_close amended --status complete --reason "all done" --force
  [ "$status" -eq 1 ]
  grep -q '^status: active' "$DOCS_ROOT/docs/plans/amended.md"
}

@test "close-plan: complete is allowed once ## Not yet specified is empty; abandoned never asks" {
  setup_docs amended amended
  run pe_close amended --status abandoned --reason "not pursuing it"
  [ "$status" -eq 0 ]
  setup_docs amended amended
  awk '/^## Not yet specified/ { print; skip = 1; next } /^## / { skip = 0 } !skip { print }' \
    "$DOCS_ROOT/docs/plans/amended.md" > "$DOCS_ROOT/docs/plans/amended.md.new"
  mv "$DOCS_ROOT/docs/plans/amended.md.new" "$DOCS_ROOT/docs/plans/amended.md"
  run pg amended --not-yet-specified
  [ -z "$output" ]
  run pe_close amended --status complete --reason "all done" --force
  [ "$status" -eq 0 ]
  grep -q '^status: complete' "$DOCS_ROOT/docs/plans/amended.md"
}
