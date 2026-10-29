#!/usr/bin/env bats
# Claim qualification: the branch and the working tree a claim declares, and the
# one narrowing they allow on top of scope (and the scope a claim writes when told none).
# (One of three files since measured-console phase 7; the shared setup is tests/helpers/lock_scope_helper.bash.)
load ../helpers/test_helper
load ../helpers/lock_scope_helper

# --- engine-4: the scope a claim writes when it is told none ------------------

@test "scope: a claim with no --scope takes the plan's Repos cell, like conflicts does" {
  # `conflicts` has always read the Repos cell when given no --scope; `claim`
  # refused to, so a hand claim (and EVERY console-issued claim — writes.ts
  # passes no --scope at all) recorded a lock with no scope, which every reader
  # treats as unknown and therefore colliding with everything.
  setup_docs scoped scoped
  pe_lock scoped claim 2 --owner sessionA
  assert_contains "$(cat "$DOCS_ROOT/docs/handoffs/scoped/.locks/phase-02.lock")" "scope=api-server"
  # And it is a REAL scope, so a disjoint phase is now free to start.
  run pe_lock scoped conflicts 3 --scope "web-app" --owner sessionB
  [ "$status" -eq 0 ]
}

@test "scope: a same-owner refresh that states no --scope keeps the one on disk" {
  # engine-4's headline. _write emits `scope=` only when it has one, and the
  # refresh branch preserved `session=` with no equivalent for scope — so a
  # keepalive or a lease extension quietly turned a scoped lock into a
  # collides-with-everything one. The runner carried a workaround whose own
  # comment said the fix belonged in the script.
  setup_docs scoped scoped
  pe_lock scoped claim 2 --owner sessionA --scope "web-app"
  pe_lock scoped claim 2 --owner sessionA
  assert_contains "$(cat "$DOCS_ROOT/docs/handoffs/scoped/.locks/phase-02.lock")" "scope=web-app"
  # An explicit --scope on the refresh still wins.
  pe_lock scoped claim 2 --owner sessionA --scope "api-server"
  assert_contains "$(cat "$DOCS_ROOT/docs/handoffs/scoped/.locks/phase-02.lock")" "scope=api-server"
}

# --- claim qualification ------------------------------------------------------
#
# The one narrowing allowed on top of scope, decided on TWO dimensions: two
# claims whose scopes intersect are nevertheless disjoint when BOTH name a
# branch and the branches differ, AND both name a working tree and the trees
# differ. Either dimension missing on either side ⇒ collide — the same
# fail-safe direction as an unstated scope. A branch alone proved nothing
# about two sessions editing one shared checkout; a tree alone would carve
# out two checkouts riding one ref.
#
# THE TABLE below is duplicated case-for-case in `viewer/test/scope.test.ts`
# (CLAIM_TABLE). Two languages decide this — `claim_disjoint` in
# scripts/scope.sh and `claimsDisjoint` in viewer/shared/scope.js — and a rule
# that lives in two places drifts unless the same cases are green in both.
# Add a row here and add it there in the same commit.

@test "claim: --branch and --worktree write their lines" {
  setup_docs scoped scoped
  pe_lock scoped claim 2 --owner sessionA --scope "api-server" \
    --branch "pe/lane-2" --worktree "/home/sam/wt/a"
  run grep '^branch=' "$DOCS_ROOT/docs/handoffs/scoped/.locks/phase-02.lock"
  [ "$output" = "branch=pe/lane-2" ]
  run grep '^worktree=' "$DOCS_ROOT/docs/handoffs/scoped/.locks/phase-02.lock"
  [ "$output" = "worktree=/home/sam/wt/a" ]
}

@test "claim: PE_BRANCH and PE_WORKTREE supply them when the flags are absent" {
  setup_docs scoped scoped
  PE_BRANCH="pe/from-env" PE_WORKTREE="/home/sam/wt/env" pe_lock scoped claim 3 --owner sessionA
  run grep '^branch=' "$DOCS_ROOT/docs/handoffs/scoped/.locks/phase-03.lock"
  [ "$output" = "branch=pe/from-env" ]
  run grep '^worktree=' "$DOCS_ROOT/docs/handoffs/scoped/.locks/phase-03.lock"
  [ "$output" = "worktree=/home/sam/wt/env" ]
}

@test "claim: a claim that names neither writes neither line at all" {
  # Absent must stay absent — a defaulted value would qualify every lock in
  # the fleet and quietly hand the carve-out to sessions that never asked.
  setup_docs scoped scoped
  pe_lock scoped claim 2 --owner sessionA --scope "api-server"
  refute_contains "$(cat "$DOCS_ROOT/docs/handoffs/scoped/.locks/phase-02.lock")" "branch="
  refute_contains "$(cat "$DOCS_ROOT/docs/handoffs/scoped/.locks/phase-02.lock")" "worktree="
}

@test "claim: --here derives BOTH dimensions from the cwd, and neither overrides an explicit value" {
  setup_docs scoped scoped
  repo="$BATS_TEST_TMPDIR/here-repo"
  mkdir -p "$repo"
  git -C "$repo" init -q -b pe/here-branch
  ( cd "$repo" && \
    git -c user.name=sam -c user.email=sam@example.invalid commit -q --allow-empty -m base && \
    pe_lock scoped claim 5 --owner sessionA --scope "api-server" --here )
  lock="$DOCS_ROOT/docs/handoffs/scoped/.locks/phase-05.lock"
  run grep '^branch=' "$lock"
  [ "$output" = "branch=pe/here-branch" ]
  run grep '^worktree=' "$lock"
  assert_contains "$output" "here-repo"
  # …and an explicit flag wins over the derivation:
  ( cd "$repo" && \
    pe_lock scoped claim 6 --owner sessionA --scope "api-server" --here --branch "pe/stated" )
  run grep '^branch=' "$DOCS_ROOT/docs/handoffs/scoped/.locks/phase-06.lock"
  [ "$output" = "branch=pe/stated" ]
}

@test "claim: status and list show both dimensions" {
  setup_docs scoped scoped
  pe_lock scoped claim 2 --owner sessionA --scope "api-server" \
    --branch "pe/lane-2" --worktree "/home/sam/wt/a"
  run pe_lock scoped status 2
  assert_contains "$output" "branch: pe/lane-2"
  assert_contains "$output" "worktree: /home/sam/wt/a"
  run pe_lock scoped list
  assert_contains "$output" "branch: pe/lane-2"
  assert_contains "$output" "worktree: /home/sam/wt/a"
}

# The table, row by row. Every row uses the SAME intersecting scope
# (`api-server`), so the only thing deciding the verdict is the pair.

@test "claim: both dimensions qualified and different is CLEAR (exit 0)" {
  setup_docs scoped scoped
  pe_lock scoped claim 2 --owner sessionA --scope "api-server" --branch "pe/a" --worktree "/home/sam/wt/a"
  run pe_lock scoped conflicts 4 --scope "api-server" --owner sessionB --branch "pe/b" --worktree "/home/sam/wt/b"
  [ "$status" -eq 0 ]
  assert_contains "$output" "on branch pe/b"
}

@test "claim: the same branch is the same work, however many trees — still a conflict" {
  setup_docs scoped scoped
  pe_lock scoped claim 2 --owner sessionA --scope "api-server" --branch "pe/a" --worktree "/home/sam/wt/a"
  run pe_lock scoped conflicts 4 --scope "api-server" --owner sessionB --branch "pe/a" --worktree "/home/sam/wt/b"
  [ "$status" -eq 1 ]
  assert_contains "$output" "CONFLICT"
}

@test "claim: one directory is one directory, whatever its refs are called" {
  # THE row the tree dimension exists for: two sessions in one shared checkout
  # on different branches used to carve out — same directory, same files.
  setup_docs scoped scoped
  pe_lock scoped claim 2 --owner sessionA --scope "api-server" --branch "pe/a" --worktree "/home/sam/repo"
  run pe_lock scoped conflicts 4 --scope "api-server" --owner sessionB --branch "pe/b" --worktree "/home/sam/repo"
  [ "$status" -eq 1 ]
  assert_contains "$output" "CONFLICT"
}

# The DETACHED rows, mirroring `CLAIM_TABLE` in test/scope.test.ts. A
# `detached@<sha12>` branch contends with nobody holding a real ref, and an
# unqualified claim would have collided with everything, which would have made
# the whole shape useless. It gets ONE rule in claim_disjoint: an EQUAL pair is
# not "the same work" — a detached HEAD is no ref for two trees' commits to
# collide on — so it falls through to the tree test (P1, W3).

@test "claim: a detached checkout contends with nobody holding a branch" {
  setup_docs scoped scoped
  pe_lock scoped claim 2 --owner sessionA --scope "api-server" \
    --branch "detached@abc123def456" --worktree "/home/sam/wt/t1"
  run pe_lock scoped conflicts 4 --scope "api-server" --owner sessionB \
    --branch "pe/x" --worktree "/home/sam/wt/t2"
  [ "$status" -eq 0 ]
}

@test "claim: two TREES detached at the SAME commit are decided by the tree alone — CLEAR" {
  setup_docs scoped scoped
  pe_lock scoped claim 2 --owner sessionA --scope "api-server" \
    --branch "detached@abc123def456" --worktree "/home/sam/wt/t1"
  run pe_lock scoped conflicts 4 --scope "api-server" --owner sessionB \
    --branch "detached@abc123def456" --worktree "/home/sam/wt/t2"
  [ "$status" -eq 0 ]
}

@test "claim: two trailing slashes are still spelling — the same tree, a conflict (P1 QA F4)" {
  setup_docs scoped scoped
  pe_lock scoped claim 2 --owner sessionA --scope "api-server" --branch "pe/a" --worktree "/home/sam/repo//"
  run pe_lock scoped conflicts 4 --scope "api-server" --owner sessionB --branch "pe/b" --worktree "/home/sam/repo"
  [ "$status" -eq 1 ]
  assert_contains "$output" "CONFLICT"
}

@test "claim: one tree detached at one commit is one tree — still a conflict" {
  setup_docs scoped scoped
  pe_lock scoped claim 2 --owner sessionA --scope "api-server" \
    --branch "detached@abc123def456" --worktree "/home/sam/wt/t1"
  run pe_lock scoped conflicts 4 --scope "api-server" --owner sessionB \
    --branch "detached@abc123def456" --worktree "/home/sam/wt/t1"
  [ "$status" -eq 1 ]
  assert_contains "$output" "CONFLICT"
  # …and a tree INSIDE it is the same ground, exactly as for a real ref.
  run pe_lock scoped conflicts 4 --scope "api-server" --owner sessionB \
    --branch "detached@abc123def456" --worktree "/home/sam/wt/t1/nested"
  [ "$status" -eq 1 ]
}

@test "claim: two trees detached at DIFFERENT commits are not" {
  setup_docs scoped scoped
  pe_lock scoped claim 2 --owner sessionA --scope "api-server" \
    --branch "detached@abc123def456" --worktree "/home/sam/wt/t1"
  run pe_lock scoped conflicts 4 --scope "api-server" --owner sessionB \
    --branch "detached@999999999999" --worktree "/home/sam/wt/t2"
  [ "$status" -eq 0 ]
}

# `--branch` takes the string exactly as given: `detached@<sha>` carries an `@`,
# which scope_normalize would have eaten had the qualification been bent into a
# scope token instead of its own lock field.
@test "claim: --branch stores a detached ref verbatim, @ and all" {
  setup_docs scoped scoped
  pe_lock scoped claim 2 --owner sessionA --scope "api-server" --branch "detached@abc123def456"
  run grep '^branch=' "$DOCS_ROOT/docs/handoffs/scoped/.locks/phase-02.lock"
  [ "$output" = "branch=detached@abc123def456" ]
}

@test "claim: a branch-only LOCK collides with a fully qualified caller" {
  # The retirement of the unsound carve: a lock naming only a branch used to
  # clear a qualified caller into the very tree its session was editing.
  setup_docs scoped scoped
  pe_lock scoped claim 2 --owner sessionA --scope "api-server" --branch "pe/a"
  run pe_lock scoped conflicts 4 --scope "api-server" --owner sessionB --branch "pe/b" --worktree "/home/sam/wt/b"
  [ "$status" -eq 1 ]
  assert_contains "$output" "worktree: unstated"
}

@test "claim: a branch-only CALLER collides with a fully qualified lock" {
  setup_docs scoped scoped
  pe_lock scoped claim 2 --owner sessionA --scope "api-server" --branch "pe/a" --worktree "/home/sam/wt/a"
  run pe_lock scoped conflicts 4 --scope "api-server" --owner sessionB --branch "pe/b"
  [ "$status" -eq 1 ]
  assert_contains "$output" "worktree: /home/sam/wt/a"
}

@test "claim: an unqualified LOCK collides with a qualified caller" {
  setup_docs scoped scoped
  pe_lock scoped claim 2 --owner sessionA --scope "api-server"
  run pe_lock scoped conflicts 4 --scope "api-server" --owner sessionB --branch "pe/b" --worktree "/home/sam/wt/b"
  [ "$status" -eq 1 ]
  # And the message says which side never declared, because "why is this a
  # conflict when we are on different branches" is the first question asked.
  assert_contains "$output" "branch: unstated"
}

@test "claim: an unqualified CALLER collides with a qualified lock" {
  setup_docs scoped scoped
  pe_lock scoped claim 2 --owner sessionA --scope "api-server" --branch "pe/a" --worktree "/home/sam/wt/a"
  run pe_lock scoped conflicts 4 --scope "api-server" --owner sessionB
  [ "$status" -eq 1 ]
  assert_contains "$output" "branch: pe/a"
}

@test "claim: neither qualified is a conflict, exactly as before the fields" {
  setup_docs scoped scoped
  pe_lock scoped claim 2 --owner sessionA --scope "api-server"
  run pe_lock scoped conflicts 4 --scope "api-server" --owner sessionB
  [ "$status" -eq 1 ]
}

@test "claim: whitespace is not a different branch, and not a different tree" {
  # bash trims at write, the TS reader trims at compare. If either stopped, a
  # lane would carve itself out from its own claim.
  setup_docs scoped scoped
  pe_lock scoped claim 2 --owner sessionA --scope "api-server" --branch "  pe/a  " --worktree "  /home/sam/wt/a  "
  assert_contains "$(cat "$DOCS_ROOT/docs/handoffs/scoped/.locks/phase-02.lock")" "branch=pe/a"
  assert_contains "$(cat "$DOCS_ROOT/docs/handoffs/scoped/.locks/phase-02.lock")" "worktree=/home/sam/wt/a"
  run pe_lock scoped conflicts 4 --scope "api-server" --owner sessionB --branch "pe/a" --worktree "/home/sam/wt/b"
  [ "$status" -eq 1 ]
  run pe_lock scoped conflicts 4 --scope "api-server" --owner sessionB --branch "pe/b" --worktree "/home/sam/wt/a"
  [ "$status" -eq 1 ]
}

@test "claim: a trailing slash is spelling, not geography" {
  setup_docs scoped scoped
  pe_lock scoped claim 2 --owner sessionA --scope "api-server" --branch "pe/a" --worktree "/home/sam/wt/a"
  run pe_lock scoped conflicts 4 --scope "api-server" --owner sessionB --branch "pe/b" --worktree "/home/sam/wt/a/"
  [ "$status" -eq 1 ]
}

@test "claim: a tree inside another tree is the same ground" {
  # A mirror's mount, or a cwd-derived toplevel under a run's workspace, must
  # not read as a different place than the workspace itself.
  setup_docs scoped scoped
  pe_lock scoped claim 2 --owner sessionA --scope "api-server" --branch "pe/a" --worktree "/home/sam/wt/a"
  run pe_lock scoped conflicts 4 --scope "api-server" --owner sessionB --branch "pe/b" --worktree "/home/sam/wt/a/nested"
  [ "$status" -eq 1 ]
}

@test "claim: tree nesting is segment-wise — a sibling with a shared prefix is another place" {
  setup_docs scoped scoped
  pe_lock scoped claim 2 --owner sessionA --scope "api-server" --branch "pe/a" --worktree "/home/sam/wt/a"
  run pe_lock scoped conflicts 4 --scope "api-server" --owner sessionB --branch "pe/b" --worktree "/home/sam/wt/a-b"
  [ "$status" -eq 0 ]
}

@test "claim: branches do NOT nest segment-wise the way trees do" {
  # `packages` ∩ `packages/cart-api` is a scope rule about directories. Refs are
  # not directories: `main` and `pe/main` are two branches, full stop.
  setup_docs scoped scoped
  pe_lock scoped claim 2 --owner sessionA --scope "api-server" --branch "main" --worktree "/home/sam/wt/a"
  run pe_lock scoped conflicts 4 --scope "api-server" --owner sessionB --branch "pe/main" --worktree "/home/sam/wt/b"
  [ "$status" -eq 0 ]
}

@test "claim: refs are case-sensitive, so two spellings are two branches" {
  setup_docs scoped scoped
  pe_lock scoped claim 2 --owner sessionA --scope "api-server" --branch "pe/a" --worktree "/home/sam/wt/a"
  run pe_lock scoped conflicts 4 --scope "api-server" --owner sessionB --branch "PE/A" --worktree "/home/sam/wt/b"
  [ "$status" -eq 0 ]
}

@test "claim: qualification narrows scope, it never widens it" {
  # A qualified pair cannot make an EXPIRED lock a conflict, and it cannot make
  # a foreign plan's intersecting lock disappear unless both dimensions differ.
  setup_docs scoped scoped
  mkdir -p "$DOCS_ROOT/docs/plans" "$DOCS_ROOT/docs/handoffs/other"
  cp "$PE_DIR/tests/fixtures/plans/scoped.md" "$DOCS_ROOT/docs/plans/other.md"
  pe_lock other claim 2 --owner sessionA --scope "api-server" --branch "pe/a" --worktree "/home/sam/wt/a"
  run pe_lock scoped conflicts 4 --scope "api-server" --owner sessionB --branch "pe/a" --worktree "/home/sam/wt/b"
  [ "$status" -eq 1 ]
  run pe_lock scoped conflicts 4 --scope "api-server" --owner sessionB --branch "pe/b" --worktree "/home/sam/wt/b"
  [ "$status" -eq 0 ]
}

# ── LCK-3 — the default owner proves nothing ─────────────────────────────────
# `owner` defaults to `<user>@<host>`, which is the SAME string for every
# hand-driven session on one machine. Skipping a lock on owner equality made
# this scan blind to every other local session: a live lock on
# `scope=phased-execution` was reported as "safe to start", and a shared working
# tree is the one thing the verb exists to refuse. A lock that names no session
# AND carries the machine default is therefore foreign — we cannot prove it is
# ours, so it is not.
