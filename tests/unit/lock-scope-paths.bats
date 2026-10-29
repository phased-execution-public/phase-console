#!/usr/bin/env bats
# Scope and paths: owners and sessions, one phase in two trees, path spellings,
# the home, symlinked trees, a RUN's hold on a shared tree, and the root token.
# (One of three files since measured-console phase 7; the shared setup is tests/helpers/lock_scope_helper.bash.)
load ../helpers/test_helper
load ../helpers/lock_scope_helper

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

# --- a RUN's hold on a shared tree (control-tower phase 40, #41) ---------------
#
# A lock is per PHASE; the branch a run checked a shared repository onto is per
# RUN, and it outlives every lock the run takes. The console writes one record
# per held repository under `<state>/trees/`; `conflicts` reads the very same
# records the scheduler does (viewer/test/branch-admission.test.ts BA-9 holds
# the two doors to one answer).

# A shared checkout: the root on main, `app` a repository of its own under it,
# checked out on run r-beta's branch and held by that run (its state `status`).
hold_setup() {
  export DOCS_ROOT="$BATS_TEST_TMPDIR/estate"
  mkdir -p "$DOCS_ROOT/app"
  git -C "$DOCS_ROOT" init -q -b main
  git -C "$DOCS_ROOT/app" init -q -b main
  printf '# app\n' >"$DOCS_ROOT/app/README.md"
  git -C "$DOCS_ROOT/app" add -A
  git -C "$DOCS_ROOT/app" -c user.name=t -c user.email=t@example.invalid commit -q -m base
  git -C "$DOCS_ROOT/app" checkout -q -b pe/beta
  DOCS_ROOT="$(cd "$DOCS_ROOT" && pwd -P)"
  mkdir -p "$XDG_STATE_HOME/phase-console/trees"
  printf '{\n  "id": "r-beta",\n  "status": "%s"\n}\n' "${1:-running}" >"$BATS_TEST_TMPDIR/run-r-beta.json"
  {
    printf 'run=r-beta\nslug=beta\nowner=autopilot/r-beta\n'
    printf 'repo=%s/app\nrel=app\nroot=%s\nbranch=pe/beta\nfound_on=main\n' "$DOCS_ROOT" "$DOCS_ROOT"
    printf 'at=2026-09-22T00:00:00Z\nrun_file=%s\n' "$BATS_TEST_TMPDIR/run-r-beta.json"
  } >"$XDG_STATE_HOME/phase-console/trees/r-beta-00000000.hold"
}

@test "hold: a repository another RUN holds on its branch is a conflict until the tree leaves the branch" {
  hold_setup
  run pe_lock alpha conflicts --scope app --branch pe/alpha --worktree "$DOCS_ROOT"
  [ "$status" -eq 1 ]
  assert_contains "$output" "CONFLICT beta run r-beta — holds app on pe/beta"
  assert_contains "$output" "a RUN holding a shared repository on its branch"
  # A superproject scope reaches the repository under it; a disjoint one does not.
  run pe_lock alpha conflicts --scope all --branch pe/alpha --worktree "$DOCS_ROOT"
  [ "$status" -eq 1 ]
  run pe_lock alpha conflicts --scope docs --branch pe/alpha --worktree "$DOCS_ROOT"
  [ "$status" -eq 0 ]
  git -C "$DOCS_ROOT/app" checkout -q main
  run pe_lock alpha conflicts --scope app --branch pe/alpha --worktree "$DOCS_ROOT"
  [ "$status" -eq 0 ]
}

@test "hold: the root's OWN name reaches the root repository alone, never a held submodule (control-tower phase 90, #150)" {
  hold_setup
  own="$(basename "$DOCS_ROOT")"
  # A hub-root phase commits by explicit pathspec and never stages `app`'s
  # gitlink: another run's hold on `app` is not its wait.
  run pe_lock alpha conflicts --scope "$own" --branch pe/alpha --worktree "$DOCS_ROOT"
  [ "$status" -eq 0 ]
  # …while naming the held repository still is, beside the root's name or not.
  run pe_lock alpha conflicts --scope "$own,app" --branch pe/alpha --worktree "$DOCS_ROOT"
  [ "$status" -eq 1 ]
  assert_contains "$output" "holds app on pe/beta"
}

@test "hold: an unqualified hand session collides; a checkout of its own and the holding run's own session do not" {
  hold_setup
  run pe_lock alpha conflicts --scope app
  [ "$status" -eq 1 ]
  mkdir -p "$DOCS_ROOT/.worktrees/hand/alpha/p1"
  run pe_lock alpha conflicts --scope app --branch pe/alpha-p1 --worktree "$DOCS_ROOT/.worktrees/hand/alpha/p1"
  [ "$status" -eq 0 ]
  run pe_lock alpha conflicts --scope app --branch pe/alpha --worktree "$DOCS_ROOT" --owner autopilot/r-beta
  [ "$status" -eq 0 ]
  # The branch the tree already stands on is no collision with a hold.
  run pe_lock alpha conflicts --scope app --branch pe/beta --worktree "$DOCS_ROOT"
  [ "$status" -eq 0 ]
}

@test "hold: a hold whose run settled holds nothing — finished, or stopped by an operator" {
  hold_setup finished
  run pe_lock alpha conflicts --scope app --branch pe/alpha --worktree "$DOCS_ROOT"
  [ "$status" -eq 0 ]
  printf '{\n  "id": "r-beta",\n  "status": "interrupted",\n  "stoppedBy": "operator"\n}\n' >"$BATS_TEST_TMPDIR/run-r-beta.json"
  run pe_lock alpha conflicts --scope app --branch pe/alpha --worktree "$DOCS_ROOT"
  [ "$status" -eq 0 ]
  # A console that died under it has not settled: the run still owns the tree.
  printf '{\n  "id": "r-beta",\n  "status": "interrupted"\n}\n' >"$BATS_TEST_TMPDIR/run-r-beta.json"
  run pe_lock alpha conflicts --scope app --branch pe/alpha --worktree "$DOCS_ROOT"
  [ "$status" -eq 1 ]
  rm -f "$BATS_TEST_TMPDIR/run-r-beta.json"
  run pe_lock alpha conflicts --scope app --branch pe/alpha --worktree "$DOCS_ROOT"
  [ "$status" -eq 0 ]
}

# ---------------------------------------------------------------------------
# control-tower phase 63 (#88): the docs root's per-slug token — the twin of
# `rootScopeToken` in viewer/shared/scope.js (root-scope.test.ts holds the two).
# ---------------------------------------------------------------------------

@test "scope_root_token: names the plan's own handoff folder, normalised" {
  . "$PE_SCRIPTS/scope.sh"
  [ "$(scope_root_token control-tower)" = "docs/handoffs/control-tower" ]
  [ "$(scope_root_token 'Control-Tower')" = "docs/handoffs/control-tower" ]
  [ -z "$(scope_root_token '')" ]
  [ -z "$(scope_root_token 'two words')" ]
}

@test "scope_root_token: intersects a docs scope, never another plan's token or a submodule" {
  . "$PE_SCRIPTS/scope.sh"
  tok="$(scope_root_token alpha)"
  scope_intersects "$tok" "docs"
  scope_intersects "$tok" "docs/handoffs"
  ! scope_intersects "$tok" "$(scope_root_token beta)"
  ! scope_intersects "$tok" "phased-execution"
  ! scope_intersects "$tok" "docs/handoffs/alpha-two"
}

@test "the root token never reaches a lock: a plan's own lanes on disjoint repos stay disjoint" {
  setup_docs scoped scoped
  run pe_lock scoped claim 1 --owner laneA --scope api-server
  [ "$status" -eq 0 ]
  ! grep -q 'docs/handoffs' "$DOCS_ROOT/docs/handoffs/scoped/.locks/phase-01.lock"
  run pe_lock scoped conflicts 2 --scope web-app --owner laneB
  [ "$status" -eq 0 ]
}
