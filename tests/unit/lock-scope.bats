#!/usr/bin/env bats
# Scope: what a phase touches, and whether a second session may run beside it.
#
# The old rule serialised everything, so a lock only had to answer "is this
# phase taken?". The new rule needs "does anything live share my working tree?",
# across ALL plans — a session in another plan holding the same repo is exactly
# the collision that matters. These tests pin the contract the console's
# scheduler is built on: exit 0 clear / 1 conflicts / 2 usage.
load ../helpers/test_helper

setup() {
  # `session=` is written only when an id is known, and this suite may itself run
  # inside a Claude session that exports one — which would silently change what
  # the conflicts scan is keying on. Same block as lock.bats, same reason.
  #
  # `PE_BRANCH` and `PE_WORKTREE` join it for a sharper version of the same
  # reason: this suite may run inside a worktree LANE, whose runner exports
  # both — and `branch=` is ACTED ON, so an inherited one would qualify every
  # lock the suite writes and turn the collision cases green for the wrong
  # reason.
  unset PE_SESSION_ID CLAUDE_CODE_SESSION_ID PE_BRANCH PE_WORKTREE
}

# --- the Repos column, read by the engine -------------------------------------

@test "scope: --repos normalises the Repos cell of every shape" {
  setup_docs scoped scoped
  run pg scoped --repos 1; [ "$output" = "api-server" ]        # `backticks`
  run pg scoped --repos 3; [ "$output" = "web-app" ]           # **bold**
  run pg scoped --repos 4; [ "$output" = "api-server,docs" ]   # comma list
  run pg scoped --repos 6; [ "$output" = "packages/cart-api" ] # aside dropped, path kept
}

@test "scope: a phase that declares no repos reads as all" {
  setup_docs scoped scoped
  run pg scoped --repos 5
  [ "$status" -eq 0 ]
  # Saying nothing must never read as "collides with nothing".
  [ "$output" = "all" ]
}

@test "scope: --repos without a phase is a usage error" {
  setup_docs scoped scoped
  run pg scoped --repos
  [ "$status" -eq 2 ]
}

@test "scope: a prose bullet mentioning scope is not a scope declaration" {
  # Real plans write "- **Scope change — X moved to Phase 4:** <prose>" inside a
  # phase block. An override keyed on that label read the prose as repo tokens —
  # the exact "missed conflict" failure this whole mechanism exists to prevent.
  # The Repos column is the only declaration; nothing in the body overrides it.
  setup_docs scoped scoped
  perl -0pi -e 's/(### Phase 2 — Api\n)/$1- **Scope change — moved to Phase 4:** a long prose sentence\n/' \
    "$DOCS_ROOT/docs/plans/scoped.md"
  run pg scoped --repos 2; [ "$output" = "api-server" ]
}

# --- the lock file ------------------------------------------------------------

@test "scope: claim --scope writes a scope= line" {
  setup_docs scoped scoped
  pe_lock scoped claim 2 --owner sessionA --scope "api-server, docs"
  run grep '^scope=' "$DOCS_ROOT/docs/handoffs/scoped/.locks/phase-02.lock"
  [ "$status" -eq 0 ]
  [ "$output" = "scope=api-server,docs" ]
}

@test "scope: PE_SCOPE supplies the scope when --scope is absent" {
  setup_docs scoped scoped
  PE_SCOPE="web-app" pe_lock scoped claim 3 --owner sessionA
  run grep '^scope=' "$DOCS_ROOT/docs/handoffs/scoped/.locks/phase-03.lock"
  [ "$output" = "scope=web-app" ]
}

@test "scope: status and list show the scope" {
  setup_docs scoped scoped
  pe_lock scoped claim 2 --owner sessionA --scope "api-server"
  run pe_lock scoped status 2
  assert_contains "$output" "scope: api-server"
  run pe_lock scoped list
  assert_contains "$output" "scope: api-server"
}

@test "scope: a lock written without one still parses (old format)" {
  setup_docs scoped scoped
  write_legacy_lock scoped 2 sessionA
  refute_contains "$(cat "$DOCS_ROOT/docs/handoffs/scoped/.locks/phase-02.lock")" "scope="
  run pe_lock scoped status 2
  [ "$status" -eq 0 ]
  assert_contains "$output" "sessionA"
  # And claiming still refuses the same phase — the old guard is untouched.
  run pe_lock scoped claim 2 --owner sessionB
  [ "$status" -eq 1 ]
}

# --- conflicts ----------------------------------------------------------------

@test "scope: conflicts is clear when nothing is held" {
  setup_docs scoped scoped
  run pe_lock scoped conflicts 2 --scope "api-server"
  [ "$status" -eq 0 ]
  assert_contains "$output" "no scope conflicts"
}

@test "scope: a disjoint scope is clear (exit 0)" {
  setup_docs scoped scoped
  pe_lock scoped claim 2 --owner sessionA --scope "api-server"
  run pe_lock scoped conflicts 3 --scope "web-app" --owner sessionB
  [ "$status" -eq 0 ]
}

@test "scope: an intersecting scope conflicts (exit 1) and names the holder" {
  setup_docs scoped scoped
  pe_lock scoped claim 2 --owner sessionA --scope "api-server,docs"
  run pe_lock scoped conflicts 4 --scope "docs" --owner sessionB
  [ "$status" -eq 1 ]
  assert_contains "$output" "CONFLICT"
  assert_contains "$output" "sessionA"
  assert_contains "$output" "docs"
}

@test "scope: all collides with everything, in both directions" {
  setup_docs scoped scoped
  pe_lock scoped claim 5 --owner sessionA --scope "all"
  run pe_lock scoped conflicts 3 --scope "web-app" --owner sessionB
  [ "$status" -eq 1 ]

  setup_docs scoped scoped
  pe_lock scoped claim 3 --owner sessionA --scope "web-app"
  run pe_lock scoped conflicts 5 --scope "all" --owner sessionB
  [ "$status" -eq 1 ]
}

@test "scope: a path prefix collides, a neighbouring name does not" {
  setup_docs scoped scoped
  pe_lock scoped claim 7 --owner sessionA --scope "packages"
  run pe_lock scoped conflicts 6 --scope "packages/cart-api" --owner sessionB
  [ "$status" -eq 1 ]

  # Segment-wise: `packages-legacy` is a different repository, not a child.
  run pe_lock scoped conflicts 6 --scope "packages-legacy" --owner sessionB
  [ "$status" -eq 0 ]
}

@test "scope: an expired lease is not a conflict" {
  setup_docs scoped scoped
  pe_lock scoped claim 2 --owner sessionA --scope "api-server"
  expire_lock scoped 2
  run pe_lock scoped conflicts 4 --scope "api-server" --owner sessionB
  [ "$status" -eq 0 ]
}

@test "scope: our own live lock is not a conflict with ourselves" {
  setup_docs scoped scoped
  pe_lock scoped claim 2 --owner sessionA --scope "api-server"
  run pe_lock scoped conflicts 4 --scope "api-server" --owner sessionA
  [ "$status" -eq 0 ]
}

# --- identity: owner is not a session ----------------------------------------
#
# `owner` defaults to `<user>@<host>`, which is the SAME string for every
# hand-driven session on one machine. Skipping a lock on owner equality
# therefore made this scan blind to every other local session: a live lock on
# `scope=phased-execution` held by another session was reported as "no scope
# conflicts — safe to start", onto a shared working tree. `session=` is the
# identity, and it decides whenever the LOCK carries one.

@test "scope: a lock naming ANOTHER session conflicts, even under our own owner" {
  setup_docs scoped scoped
  pe_lock scoped claim 2 --owner sessionA --session theirs --scope "api-server"
  run pe_lock scoped conflicts 4 --scope "api-server" --owner sessionA --session mine
  [ "$status" -eq 1 ]
  assert_contains "$output" "CONFLICT"
  assert_contains "$output" "theirs"
}

@test "scope: our OWN session's other phase is still not a conflict" {
  # The batch case the owner check used to cover, and must keep covering.
  setup_docs scoped scoped
  pe_lock scoped claim 2 --owner sessionA --session mine --scope "api-server"
  run pe_lock scoped conflicts 4 --scope "api-server" --owner sessionA --session mine
  [ "$status" -eq 0 ]
}

@test "scope: a lock naming a session is not ours when we carry no session id" {
  # We cannot prove it is ours, so it is not — the fail-safe direction.
  setup_docs scoped scoped
  pe_lock scoped claim 2 --owner sessionA --session theirs --scope "api-server"
  run pe_lock scoped conflicts 4 --scope "api-server" --owner sessionA
  [ "$status" -eq 1 ]
  assert_contains "$output" "theirs"
}

@test "scope: a lock with NO session recorded still falls back to owner" {
  # Then owner is all there is to go on, and a pre-session lock of our own must
  # not cry wolf against us.
  setup_docs scoped scoped
  write_legacy_lock scoped 2 sessionA
  run pe_lock scoped conflicts 4 --scope "api-server" --owner sessionA --session mine
  [ "$status" -eq 0 ]
}

@test "scope: a lock with no scope conflicts with everything (unknown is unsafe)" {
  setup_docs scoped scoped
  write_legacy_lock scoped 2 sessionA
  run pe_lock scoped conflicts 3 --scope "web-app" --owner sessionB
  [ "$status" -eq 1 ]
  assert_contains "$output" "unstated"
}

@test "scope: conflicts sees locks held by OTHER plans" {
  # The whole point of the verb: a working tree does not know which plan asked
  # for it, so admission has to look across every plan's locks.
  setup_docs scoped scoped
  mkdir -p "$DOCS_ROOT/docs/plans" "$DOCS_ROOT/docs/handoffs/other"
  cp "$PE_DIR/tests/fixtures/plans/scoped.md" "$DOCS_ROOT/docs/plans/other.md"
  pe_lock other claim 2 --owner sessionA --scope "api-server"

  run pe_lock scoped conflicts 2 --scope "api-server" --owner sessionB
  [ "$status" -eq 1 ]
  assert_contains "$output" "other"

  run pe_lock scoped conflicts 3 --scope "web-app" --owner sessionB
  [ "$status" -eq 0 ]
}

@test "scope: conflicts reads the plan when no scope is given" {
  setup_docs scoped scoped
  pe_lock scoped claim 2 --owner sessionA --scope "api-server"
  # Phase 4 is `api-server, docs` in the plan — collides without being told.
  run pe_lock scoped conflicts 4 --owner sessionB
  [ "$status" -eq 1 ]
  run pe_lock scoped conflicts 3 --owner sessionB
  [ "$status" -eq 0 ]
}

@test "scope: conflicts with no scope and no phase is a usage error" {
  setup_docs scoped scoped
  run pe_lock scoped conflicts --owner sessionB
  [ "$status" -eq 2 ]
}

@test "scope: conflicts never writes a lock" {
  setup_docs scoped scoped
  pe_lock scoped conflicts 2 --scope "api-server" --owner sessionB
  [ ! -f "$DOCS_ROOT/docs/handoffs/scoped/.locks/phase-02.lock" ]
}

@test "scope: claiming still refuses only the same phase, not an overlapping one" {
  # Deliberate: policy lives in the console, so an older script and an older
  # console keep working. `conflicts` is what answers the scope question.
  setup_docs scoped scoped
  pe_lock scoped claim 2 --owner sessionA --scope "api-server"
  run pe_lock scoped claim 4 --owner sessionB --scope "api-server,docs"
  [ "$status" -eq 0 ]
}

# --- what the prompts tell a session to do ------------------------------------

@test "scope: the boot prompt carries the scope, the check and the invariant" {
  setup_docs scoped scoped
  run pg scoped --boot-prompt 6
  [ "$status" -eq 0 ]
  assert_contains "$output" "SCOPE"
  assert_contains "$output" "packages/cart-api"
  assert_contains "$output" "conflicts 6 --scope"
  # The claim command must NOT carry --owner: the autopilot exports PE_OWNER to
  # its sessions, and an explicit --owner in the prompt overrode it — the child
  # then held a lock the supervisor could not release, and a later retry parked
  # on "locked by a stranger". phase-lock.sh defaults to $PE_OWNER else user@host,
  # so the right command names no owner and the prose explains when a person may.
  assert_contains "$output" "claim 6 --scope"
  refute_contains "$output" "claim 6 --owner"
  assert_contains "$output" "PE_OWNER"
  assert_contains "$output" "disjoint ⇒ parallel"
  # The old unconditional rule is gone.
  refute_contains "$output" "run SERIALLY"
}

@test "scope: the next-phase banner separates disjoint siblings from shared ones" {
  setup_docs scoped scoped
  write_handoff scoped 1 root complete
  run pe_nextp scoped 1
  [ "$status" -eq 0 ]
  assert_contains "$output" "Disjoint scopes"
  assert_contains "$output" "2∥3"
  assert_contains "$output" "Shared scope"
  assert_contains "$output" "6∩7"
}

@test "lock: releasing the last lock of a plan-less slug removes the empty husk" {
  # A slug with no plan, no handoffs and no INDEX exists only because a lock
  # was claimed under it. Releasing that lock must not leave a folder whose
  # entire content is an empty .locks/ — the viewer's store reads that as an
  # orphan that exists for no reason (one such husk was found live, left by a
  # stale-claim release).
  setup_docs scoped scoped
  pe_lock ghost claim 1 --owner sessionA --scope "api"
  [ -f "$DOCS_ROOT/docs/handoffs/ghost/.locks/phase-01.lock" ]
  pe_lock ghost release 1 --owner sessionA
  [ ! -d "$DOCS_ROOT/docs/handoffs/ghost" ]
}

@test "lock: releasing one lock of a slug with handoffs leaves the folder alone" {
  setup_docs scoped scoped
  write_handoff scoped 1 root complete
  pe_lock scoped claim 2 --owner sessionA --scope "api-server"
  pe_lock scoped release 2 --owner sessionA
  [ -d "$DOCS_ROOT/docs/handoffs/scoped" ]
}

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
@test "scope: two default-owner hand sessions read each other as FOREIGN (LCK-3)" {
  setup_docs scoped scoped
  pe_lock scoped claim 2 --scope "api-server"
  run pe_lock scoped conflicts 4 --scope "api-server"
  [ "$status" -eq 1 ]
  assert_contains "$output" "CONFLICT"
}

@test "scope: a NAMED owner with no session is still ours (LCK-3 narrows, it does not widen)" {
  # The batch case: `--owner sessionA` is a per-session identity the caller
  # chose, so owner equality is evidence there. Only the machine default is not.
  setup_docs scoped scoped
  write_legacy_lock scoped 2 sessionA
  run pe_lock scoped conflicts 4 --scope "api-server" --owner sessionA --session mine
  [ "$status" -eq 0 ]
}

# ── S7-5 — bash lacked the scheduler's sameUnitOfWork rule ───────────────────
# Two claims on ONE phase of ONE plan are the same unit of work however they are
# qualified: they write the same handoff, the same lock and the same commit.
# Branch+tree carve two DIFFERENT phases apart; they must never carve one phase
# apart, or bash answers "disjoint" where the console answers "collides".
@test "scope: two claims on ONE phase collide even in different trees (S7-5)" {
  setup_docs scoped scoped
  pe_lock scoped claim 2 --owner sessionA --session theirs --scope "api-server" \
    --branch "pe/a" --worktree "/home/sam/wt/a"
  run pe_lock scoped conflicts 2 --scope "api-server" --owner sessionB --session mine \
    --branch "pe/b" --worktree "/home/sam/wt/b"
  [ "$status" -eq 1 ]
  assert_contains "$output" "CONFLICT"
}

@test "scope: the same phase NUMBER in another plan is a different unit of work (S7-5)" {
  # sameUnitOfWork is (slug, phase) — the pair, never the number alone.
  setup_docs scoped scoped
  mkdir -p "$DOCS_ROOT/docs/plans" "$DOCS_ROOT/docs/handoffs/other"
  cp "$PE_DIR/tests/fixtures/plans/scoped.md" "$DOCS_ROOT/docs/plans/other.md"
  pe_lock other claim 2 --owner sessionA --session theirs --scope "api-server" \
    --branch "pe/a" --worktree "/home/sam/wt/a"
  run pe_lock scoped conflicts 2 --scope "api-server" --owner sessionB --session mine \
    --branch "pe/b" --worktree "/home/sam/wt/b"
  [ "$status" -eq 0 ]
}

# ── SCP-1 / S11-a — the bash half of the two path rules ──────────────────────
@test "scope: a `..` segment is folded, so a relative spelling collides (SCP-1)" {
  setup_docs scoped scoped
  pe_lock scoped claim 2 --owner sessionA --session theirs --scope "api-server"
  run pe_lock scoped conflicts 4 --scope "docs/../api-server" --owner sessionB --session mine
  [ "$status" -eq 1 ]
  assert_contains "$output" "CONFLICT"
}

@test "scope: a console-managed tree does not nest into the root holding it (S11-a)" {
  # `worktreeRoot: project` puts every managed tree at `<root>/.worktrees/…`,
  # so plain containment made a shared run collide with every isolated run
  # beside it — and the same runs under `state` carved cleanly.
  setup_docs scoped scoped
  pe_lock scoped claim 2 --owner sessionA --session theirs --scope "api-server" \
    --branch "pe/other" --worktree "/repo/.worktrees/runs/other/abc/integration"
  run pe_lock scoped conflicts 4 --scope "api-server" --owner sessionB --session mine \
    --branch "pe/shared" --worktree "/repo"
  [ "$status" -eq 0 ]
}

@test "scope: beyond the home, nesting is nesting again (S11-a narrows, it does not delete)" {
  setup_docs scoped scoped
  pe_lock scoped claim 2 --owner sessionA --session theirs --scope "api-server" \
    --branch "pe/a" --worktree "/repo/.worktrees/runs/a/f0/integration"
  run pe_lock scoped conflicts 4 --scope "api-server" --owner sessionB --session mine \
    --branch "pe/b" --worktree "/repo/.worktrees/runs/a/f0/integration/phased-execution"
  [ "$status" -eq 1 ]
}

@test "scope: a directory merely NAMED like the home is not the home (S11-a)" {
  setup_docs scoped scoped
  pe_lock scoped claim 2 --owner sessionA --session theirs --scope "api-server" \
    --branch "pe/a" --worktree "/repo/.worktreesX/thing"
  run pe_lock scoped conflicts 4 --scope "api-server" --owner sessionB --session mine \
    --branch "pe/b" --worktree "/repo"
  [ "$status" -eq 1 ]
}

# ── SCH-1 — the tree dimension was a raw string compare ──────────────────────
# `/tmp/x` and `/private/tmp/x` are ONE directory on macOS. A lock recorded with
# the first spelling and a caller standing in the second carved apart — two
# sessions in one working tree, cleared by a symlink. `--here` already derives
# `pwd -P` for the CALLER; the missing half was the lock's own recorded path,
# which is read verbatim off a file somebody else wrote.
@test "scope: a lock recorded at /tmp/x collides with a caller at /private/tmp/x (SCH-1)" {
  setup_docs scoped scoped
  real="$(cd /tmp && pwd -P)"          # /private/tmp on macOS, /tmp elsewhere
  if [ "$real" = "/tmp" ]; then skip "no symlinked /tmp on this filesystem"; fi
  mkdir -p /tmp/sch1-tree
  pe_lock scoped claim 2 --owner sessionA --session theirs --scope "api-server" \
    --branch "pe/a" --worktree "/tmp/sch1-tree"
  run pe_lock scoped conflicts 4 --scope "api-server" --owner sessionB --session mine \
    --branch "pe/b" --worktree "$real/sch1-tree"
  [ "$status" -eq 1 ]
  assert_contains "$output" "CONFLICT"
}

@test "scope: the claim writes the PHYSICAL spelling of its tree (SCH-1)" {
  setup_docs scoped scoped
  real="$(cd /tmp && pwd -P)"
  if [ "$real" = "/tmp" ]; then skip "no symlinked /tmp on this filesystem"; fi
  mkdir -p /tmp/sch1-write
  pe_lock scoped claim 2 --owner sessionA --scope "api-server" --worktree "/tmp/sch1-write"
  grep -q "^worktree=$real/sch1-write\$" "$DOCS_ROOT/docs/handoffs/scoped/.locks/phase-02.lock"
}

@test "scope: a tree that does not exist is recorded as written (SCH-1)" {
  # Nothing to resolve, and inventing a resolution would be worse than keeping
  # the caller's word: a path on another machine, or one not made yet.
  setup_docs scoped scoped
  pe_lock scoped claim 2 --owner sessionA --scope "api-server" --worktree "/no/such/tree"
  grep -q '^worktree=/no/such/tree$' "$DOCS_ROOT/docs/handoffs/scoped/.locks/phase-02.lock"
}

@test "scope: a lock ALREADY on disk with the symlinked spelling still collides (SCH-1, the read side)" {
  # The write side canonicalises from now on; this is every lock written before
  # it did, and every one written by something that is not this script. The
  # comparison happens against a file somebody else wrote, so the READER has to
  # resolve too — otherwise the fix only protects locks that never needed it.
  setup_docs scoped scoped
  real="$(cd /tmp && pwd -P)"
  if [ "$real" = "/tmp" ]; then skip "no symlinked /tmp on this filesystem"; fi
  mkdir -p /tmp/sch1-read
  mkdir -p "$DOCS_ROOT/docs/handoffs/scoped/.locks"
  now="$(date +%s)"
  cat > "$DOCS_ROOT/docs/handoffs/scoped/.locks/phase-02.lock" <<EOF
slug=scoped
phase=2
owner=sessionA
host=testhost
claimed_at=$now
lease_until=$((now + 1800))
scope=api-server
session=theirs
worktree=/tmp/sch1-read
branch=pe/a
EOF
  run pe_lock scoped conflicts 4 --scope "api-server" --owner sessionB --session mine \
    --branch "pe/b" --worktree "$real/sch1-read"
  [ "$status" -eq 1 ]
  assert_contains "$output" "CONFLICT"
}
