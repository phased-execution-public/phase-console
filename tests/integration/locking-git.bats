#!/usr/bin/env bats
# Git-synced phase locks: a claim committed+pushed by one clone is seen by another
# clone after pull, so a second session is correctly refused (cross-account guard).
load ../helpers/test_helper

@test "a --git lock claimed in clone A is seen by clone B and refuses its claim" {
  origin="$BATS_TEST_TMPDIR/origin.git"
  git -c init.defaultBranch=main init -q --bare "$origin"
  A="$BATS_TEST_TMPDIR/A"; B="$BATS_TEST_TMPDIR/B"

  git clone -q "$origin" "$A"
  git -C "$A" config user.email t@t.t; git -C "$A" config user.name a
  mkdir -p "$A/docs/plans" "$A/docs/handoffs/demo"
  cp "$PE_DIR/tests/fixtures/plans/diamond.md" "$A/docs/plans/demo.md"
  git -C "$A" add -A; git -C "$A" commit -qm init; git -C "$A" push -q -u origin main

  git clone -q "$origin" "$B"
  git -C "$B" config user.email t@t.t; git -C "$B" config user.name b

  # Session A claims phase 1 and pushes the lock.
  env DOCS_ROOT="$A" /bin/bash "$PE_SCRIPTS/phase-lock.sh" demo claim 1 --owner sessA --git
  [ -f "$A/docs/handoffs/demo/.locks/phase-01.lock" ]

  # Session B (a different clone) pulls and is refused, told who holds it.
  run env DOCS_ROOT="$B" /bin/bash "$PE_SCRIPTS/phase-lock.sh" demo claim 1 --owner sessB --git
  [ "$status" -ne 0 ]
  assert_contains "$output" "sessA"
  [ -f "$B/docs/handoffs/demo/.locks/phase-01.lock" ]   # the lock arrived via pull
}

@test "a push that lost a race is rebased and pushed again, not dropped" {
  # The real collision once phases run concurrently: two sessions finish at the
  # same moment and both commit the same handoff folder from different clones.
  # The loser's push is rejected as non-fast-forward — a state that clears by
  # itself — so the lock has to rebase onto what landed and try again.
  origin="$BATS_TEST_TMPDIR/o3.git"
  git -c init.defaultBranch=main init -q --bare "$origin"
  A="$BATS_TEST_TMPDIR/A3"; B="$BATS_TEST_TMPDIR/B3"

  git clone -q "$origin" "$A"
  git -C "$A" config user.email t@t.t; git -C "$A" config user.name a
  mkdir -p "$A/docs/plans" "$A/docs/handoffs/demo"
  cp "$PE_DIR/tests/fixtures/plans/scoped.md" "$A/docs/plans/demo.md"
  git -C "$A" add -A; git -C "$A" commit -qm init; git -C "$A" push -q -u origin main

  git clone -q "$origin" "$B"
  git -C "$B" config user.email t@t.t; git -C "$B" config user.name b

  # B loses the race exactly once: a pre-push hook lands a commit from A first,
  # so B's first push is rejected and only the retry can succeed.
  mkdir -p "$B/.git/hooks"
  cat > "$B/.git/hooks/pre-push" <<EOF
#!/bin/sh
[ -f "$BATS_TEST_TMPDIR/raced" ] && exit 0
: > "$BATS_TEST_TMPDIR/raced"
env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE sh -c 'cd "$A" &&
  echo other >> notes.txt && git add notes.txt && git commit -qm other &&
  git push -q origin main' >/dev/null 2>&1
exit 0
EOF
  chmod +x "$B/.git/hooks/pre-push"

  run env DOCS_ROOT="$B" PE_GIT_RETRY_DELAY=0 /bin/bash \
    "$PE_SCRIPTS/phase-lock.sh" demo claim 2 --owner sessB --scope api-server --git
  [ "$status" -eq 0 ]
  assert_contains "$output" "git sync retry"

  # The lock survived the race: it is on origin, alongside A's commit.
  git -C "$A" pull -q --rebase
  [ -f "$A/docs/handoffs/demo/.locks/phase-02.lock" ]
  run grep '^scope=' "$A/docs/handoffs/demo/.locks/phase-02.lock"
  [ "$output" = "scope=api-server" ]
}

@test "a held index.lock never costs the caller its claim" {
  # git's own index.lock is the serialization for the docs repo — deliberately,
  # instead of making handoff commits part of a phase's scope. It has to be
  # survivable: publishing the lock is cooperative, holding it is not optional.
  origin="$BATS_TEST_TMPDIR/o4.git"
  git -c init.defaultBranch=main init -q --bare "$origin"
  A="$BATS_TEST_TMPDIR/A4"
  git clone -q "$origin" "$A"
  git -C "$A" config user.email t@t.t; git -C "$A" config user.name a
  mkdir -p "$A/docs/plans" "$A/docs/handoffs/demo"
  cp "$PE_DIR/tests/fixtures/plans/scoped.md" "$A/docs/plans/demo.md"
  git -C "$A" add -A; git -C "$A" commit -qm init; git -C "$A" push -q -u origin main

  : > "$A/.git/index.lock"          # another git process is mid-write
  run env DOCS_ROOT="$A" PE_GIT_RETRIES=2 PE_GIT_RETRY_DELAY=0 /bin/bash \
    "$PE_SCRIPTS/phase-lock.sh" demo claim 2 --owner sessA --scope api-server --git
  rm -f "$A/.git/index.lock"

  [ "$status" -eq 0 ]                                             # the claim held
  assert_contains "$output" "git sync retry"                      # and it did retry
  [ -f "$A/docs/handoffs/demo/.locks/phase-02.lock" ]             # on disk regardless
}

@test "same session re-claim across a pull is idempotent" {
  origin="$BATS_TEST_TMPDIR/o2.git"
  git -c init.defaultBranch=main init -q --bare "$origin"
  A="$BATS_TEST_TMPDIR/A2"
  git clone -q "$origin" "$A"
  git -C "$A" config user.email t@t.t; git -C "$A" config user.name a
  mkdir -p "$A/docs/plans" "$A/docs/handoffs/demo"
  cp "$PE_DIR/tests/fixtures/plans/diamond.md" "$A/docs/plans/demo.md"
  git -C "$A" add -A; git -C "$A" commit -qm init; git -C "$A" push -q -u origin main

  env DOCS_ROOT="$A" /bin/bash "$PE_SCRIPTS/phase-lock.sh" demo claim 1 --owner sessA --git
  run env DOCS_ROOT="$A" /bin/bash "$PE_SCRIPTS/phase-lock.sh" demo claim 1 --owner sessA --git
  [ "$status" -eq 0 ]
  assert_contains "$output" "refreshed"
}

# --- D5: a push that CANNOT land, and a rebase that must not be left behind ----

@test "D5/SCH-2: a lock commit that loses to a FOREIGN upstream lock is dropped, and the clone can still pull" {
  # The other end of the race above: B does not merely lose it, it loses it to a
  # commit that touches the SAME lock file, so the rebase between retries
  # CONFLICTS and no number of retries can ever publish B's commit.
  #
  # Three things used to be wrong, and the third is the one that outlived the
  # other two. `_git_pull` swallowed git's exit code and left the repo
  # mid-rebase; `_git_sync` exhausted its retries and `return 0`'d in silence.
  # Both were fixed. What was not: the unpublishable commit STAYED on B's clone,
  # so every later `_git_refresh` rebased it onto the upstream again, conflicted
  # again and aborted again — B could never pull anything, ever, and its
  # `conflicts` answered for the rest of its life from a clone frozen at the
  # moment it lost one race. A shared docs index is the one thing every session
  # on the machine touches, so one session's dead clone is every session's
  # stale answer (G-IDX).
  #
  # And once the upstream is READ rather than merely pushed to, the claim itself
  # is answerable: the lock upstream is held by somebody else, so B does not
  # hold this phase. Saying "claimed" would be the same lie the silent
  # `return 0` told.
  origin="$BATS_TEST_TMPDIR/o5.git"
  git -c init.defaultBranch=main init -q --bare "$origin"
  A="$BATS_TEST_TMPDIR/A5"; B="$BATS_TEST_TMPDIR/B5"

  git clone -q "$origin" "$A"
  git -C "$A" config user.email t@t.t; git -C "$A" config user.name a
  mkdir -p "$A/docs/plans" "$A/docs/handoffs/demo"
  cp "$PE_DIR/tests/fixtures/plans/scoped.md" "$A/docs/plans/demo.md"
  git -C "$A" add -A; git -C "$A" commit -qm init; git -C "$A" push -q -u origin main

  git clone -q "$origin" "$B"
  git -C "$B" config user.email t@t.t; git -C "$B" config user.name b

  # On B's first push, A lands its OWN phase-01.lock. Every later rebase of B's
  # commit onto that conflicts, so no number of retries can ever publish it.
  mkdir -p "$B/.git/hooks"
  cat > "$B/.git/hooks/pre-push" <<EOF
#!/bin/sh
[ -f "$BATS_TEST_TMPDIR/raced5" ] && exit 0
: > "$BATS_TEST_TMPDIR/raced5"
env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE sh -c 'cd "$A" &&
  mkdir -p docs/handoffs/demo/.locks &&
  printf "slug=demo\nphase=1\nowner=sessA\nhost=a\nclaimed_at=1\nlease_until=9999999999\n" \
    > docs/handoffs/demo/.locks/phase-01.lock &&
  git add -A && git commit -qm "A claims 1" && git push -q origin main' >/dev/null 2>&1
exit 0
EOF
  chmod +x "$B/.git/hooks/pre-push"

  run env DOCS_ROOT="$B" PE_GIT_RETRIES=2 PE_GIT_RETRY_DELAY=0 \
    /bin/bash "$PE_SCRIPTS/phase-lock.sh" demo claim 1 --owner sessB --git

  # B does NOT hold phase 1 — the upstream says sessA does.
  [ "$status" -eq 1 ]
  assert_contains "$output" "sessA"
  [ ! -f "$B/docs/handoffs/demo/.locks/phase-01.lock" ]

  # Nothing is left mid-rebase for the next session to discover.
  [ ! -d "$B/.git/rebase-merge" ]
  [ ! -d "$B/.git/rebase-apply" ]
  run git -C "$B" rev-parse --abbrev-ref HEAD
  [ "$output" = "main" ]

  # And the clause this test exists for: the clone is not poisoned. A pull
  # works, and it brings A's lock down.
  rm -f "$B/.git/hooks/pre-push"
  run git -C "$B" pull --rebase --autostash
  [ "$status" -eq 0 ]
  [ -f "$B/docs/handoffs/demo/.locks/phase-01.lock" ]
  grep -q '^owner=sessA$' "$B/docs/handoffs/demo/.locks/phase-01.lock"
}

@test "D5/SCH-2: an unpushable commit with NO foreign upstream lock keeps the claim and says UNPUBLISHED" {
  # The other half of the resolution, and the reason it is a resolution rather
  # than a blanket rollback: the push failed for a reason that is nothing to do
  # with this phase (here a remote that refuses every push). Nobody else holds
  # the lock, so the claim on B's disk is true — it is simply local-only, which
  # is exactly what UNPUBLISHED has always meant. The commit still comes off, so
  # the clone can pull.
  origin="$BATS_TEST_TMPDIR/o7.git"
  git -c init.defaultBranch=main init -q --bare "$origin"
  B="$BATS_TEST_TMPDIR/B7"

  git clone -q "$origin" "$B"
  git -C "$B" config user.email t@t.t; git -C "$B" config user.name b
  mkdir -p "$B/docs/plans" "$B/docs/handoffs/demo"
  cp "$PE_DIR/tests/fixtures/plans/scoped.md" "$B/docs/plans/demo.md"
  git -C "$B" add -A; git -C "$B" commit -qm init; git -C "$B" push -q -u origin main

  mkdir -p "$origin/hooks"
  printf '#!/bin/sh\nexit 1\n' > "$origin/hooks/pre-receive"
  chmod +x "$origin/hooks/pre-receive"

  run env DOCS_ROOT="$B" PE_GIT_RETRIES=2 PE_GIT_RETRY_DELAY=0 \
    /bin/bash "$PE_SCRIPTS/phase-lock.sh" demo claim 1 --owner sessB --git
  [ "$status" -eq 0 ]
  assert_contains "$output" "claimed by sessB"
  assert_contains "$output" "UNPUBLISHED"
  [ -f "$B/docs/handoffs/demo/.locks/phase-01.lock" ]

  # The clone is clean and can pull: nothing unpublishable is left on it.
  run git -C "$B" rev-parse --abbrev-ref HEAD
  [ "$output" = "main" ]
  run git -C "$B" rev-list --count origin/main..HEAD
  [ "$output" = "0" ]
  rm -f "$origin/hooks/pre-receive"
  run git -C "$B" pull --rebase --autostash
  [ "$status" -eq 0 ]
}

@test "D5: a claim that publishes normally never says UNPUBLISHED" {
  # The word has to mean something: a green push must not print it.
  origin="$BATS_TEST_TMPDIR/o6.git"
  git -c init.defaultBranch=main init -q --bare "$origin"
  A="$BATS_TEST_TMPDIR/A6"
  git clone -q "$origin" "$A"
  git -C "$A" config user.email t@t.t; git -C "$A" config user.name a
  mkdir -p "$A/docs/plans" "$A/docs/handoffs/demo"
  cp "$PE_DIR/tests/fixtures/plans/scoped.md" "$A/docs/plans/demo.md"
  git -C "$A" add -A; git -C "$A" commit -qm init; git -C "$A" push -q -u origin main

  run env DOCS_ROOT="$A" /bin/bash "$PE_SCRIPTS/phase-lock.sh" demo claim 1 --owner sessA --git
  [ "$status" -eq 0 ]
  assert_contains "$output" "claimed by sessA"
  [[ "$output" != *UNPUBLISHED* ]]
}
