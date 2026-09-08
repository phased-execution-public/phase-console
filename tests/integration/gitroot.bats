#!/usr/bin/env bats
# DOCS_ROOT resolution (F7/F13): resolve via git from a subdir; clear hint when
# there is no git repo and DOCS_ROOT is unset.
load ../helpers/test_helper

@test "resolves DOCS_ROOT via git from a nested subdirectory" {
  root="$BATS_TEST_TMPDIR/repo"
  mkdir -p "$root/docs/plans" "$root/sub/deep"
  cp "$PE_DIR/tests/fixtures/plans/linear.md" "$root/docs/plans/demo.md"
  git -C "$root" init -q
  git -C "$root" config user.email t@t.t; git -C "$root" config user.name t
  run env -u DOCS_ROOT bash -c "cd '$root/sub/deep' && /bin/bash '$PE_SCRIPTS/phase-graph.sh' demo --ready"
  [ "$status" -eq 0 ]
  [ "$output" = "1" ]
}

@test "not inside a git repo (DOCS_ROOT unset) gives a clear hint" {
  d="$BATS_TEST_TMPDIR/plain"; mkdir -p "$d"
  run env -u DOCS_ROOT bash -c "cd '$d' && /bin/bash '$PE_SCRIPTS/phase-graph.sh' nope --ready"
  [ "$status" -ne 0 ]
  assert_contains "$output" "not inside a git repo"
}

# A lane — `git worktree add` of a SUBMODULE — is where the superproject probe
# goes silent: the lane is not a submodule checkout, it is a second tree of the
# submodule's repository, so `--show-superproject-working-tree` answers nothing
# and the old fallback (`--show-toplevel`) named the lane itself. The lane holds
# no docs/, so answering the plan proves the resolver found the hub.
@test "resolves DOCS_ROOT from inside a linked worktree (lane) of a submodule" {
  setup_super_lane "$BATS_TEST_TMPDIR/hub"
  run env -u DOCS_ROOT bash -c "cd '$LANE' && /bin/bash '$PE_SCRIPTS/phase-graph.sh' demo --ready"
  [ "$status" -eq 0 ]
  [ "$output" = "1" ]
}

@test "resolves DOCS_ROOT to the MAIN tree from inside a linked worktree of a plain repository" {
  root="$BATS_TEST_TMPDIR/repo"
  mkdir -p "$root/docs/plans"
  cp "$PE_DIR/tests/fixtures/plans/linear.md" "$root/docs/plans/demo.md"
  git -C "$root" init -q
  git -C "$root" config user.email t@t.t; git -C "$root" config user.name t
  git -C "$root" add -A; git -C "$root" commit -qm init
  git -C "$root" worktree add -q "$BATS_TEST_TMPDIR/lane" -b pe/demo-p1 >/dev/null 2>&1
  # Only the MAIN tree records phase 1 as done — the lane's own docs/ copy does
  # not — so `--ready` answering 2 proves which tree the resolver chose.
  mkdir -p "$root/docs/handoffs/demo"
  printf -- '---\nplan: docs/plans/demo.md\nphase: 1\ntitle: a\nstatus: complete\n---\n' > "$root/docs/handoffs/demo/phase-01-a.md"
  run env -u DOCS_ROOT bash -c "cd '$BATS_TEST_TMPDIR/lane' && /bin/bash '$PE_SCRIPTS/phase-graph.sh' demo --ready"
  [ "$status" -eq 0 ]
  [ "$output" = "2" ]
}

@test "a lane of a NESTED submodule resolves to the OUTERMOST superproject" {
  setup_super_lane "$BATS_TEST_TMPDIR/hub"
  inner="$BATS_TEST_TMPDIR/innersrc"
  mkdir -p "$inner"
  git -C "$inner" init -q
  git -C "$inner" config user.email t@t.t; git -C "$inner" config user.name t
  echo y > "$inner/g"; git -C "$inner" add g; git -C "$inner" commit -qm init
  git -C "$HUB/sub" -c protocol.file.allow=always submodule add -q "$inner" inner >/dev/null 2>&1
  git -C "$HUB/sub" commit -qm inner
  git -C "$HUB/sub/inner" worktree add -q "$BATS_TEST_TMPDIR/inner-lane" -b pe/demo-p2 >/dev/null 2>&1
  run env -u DOCS_ROOT bash -c "cd '$BATS_TEST_TMPDIR/inner-lane' && /bin/bash '$PE_SCRIPTS/phase-graph.sh' demo --ready"
  [ "$status" -eq 0 ]
  [ "$output" = "1" ]
}

# Drift lint: the resolver is ONE function in instance.sh. Twelve private copies
# once agreed about a submodule checkout and disagreed about a lane — the day a
# rule changes, every copy that was not updated is a script that answers a
# different docs root from the rest.
@test "only instance.sh probes git for the superproject — every script shares one resolver" {
  run bash -c "grep -l 'show-superproject-working-tree' '$PE_SCRIPTS'/*.sh"
  [ "$output" = "$PE_SCRIPTS/instance.sh" ]
}

# A submodule initialised INSIDE a linked worktree of its superproject has a
# common git directory of the shape `<hub>/.git/worktrees/<id>/modules/<sub>`,
# which the first cut of the resolver did not recognise — so a lane of THAT
# submodule mis-rooted exactly as before. The hub's main tree owns it.
@test "a lane of a submodule initialised inside a superproject WORKTREE resolves to the hub's main tree" {
  setup_super_lane "$BATS_TEST_TMPDIR/hub"
  git -C "$HUB" worktree add -q "$BATS_TEST_TMPDIR/hub-wt" -b wt >/dev/null 2>&1
  git -C "$BATS_TEST_TMPDIR/hub-wt" -c protocol.file.allow=always submodule update --init -q >/dev/null 2>&1
  git -C "$BATS_TEST_TMPDIR/hub-wt/sub" worktree add -q "$BATS_TEST_TMPDIR/sublane" -b pe/demo-p3 >/dev/null 2>&1
  run env -u DOCS_ROOT bash -c "cd '$BATS_TEST_TMPDIR/sublane' && /bin/bash '$PE_SCRIPTS/phase-graph.sh' demo --ready"
  [ "$status" -eq 0 ]
  [ "$output" = "1" ]
}

# A nested submodule initialised INSIDE a lane: the first probe answers the
# lane (it is the inner repo's superproject), and the walk used to stop there
# because a linked worktree answers no superproject of its own.
@test "a nested submodule initialised inside a lane walks through the lane to the hub" {
  setup_super_lane "$BATS_TEST_TMPDIR/hub"
  inner="$BATS_TEST_TMPDIR/innersrc"
  mkdir -p "$inner"
  git -C "$inner" init -q
  git -C "$inner" config user.email t@t.t; git -C "$inner" config user.name t
  echo y > "$inner/g"; git -C "$inner" add g; git -C "$inner" commit -qm init
  git -C "$HUB/sub" -c protocol.file.allow=always submodule add -q "$inner" inner >/dev/null 2>&1
  git -C "$HUB/sub" commit -qm inner
  # The lane was made BEFORE the nested submodule existed on pe/demo-p1; bring it in and init there.
  git -C "$LANE" merge -q "$(git -C "$HUB/sub" rev-parse --abbrev-ref HEAD)" >/dev/null 2>&1
  git -C "$LANE" -c protocol.file.allow=always submodule update --init -q >/dev/null 2>&1
  [ -e "$LANE/inner/.git" ]
  run env -u DOCS_ROOT bash -c "cd '$LANE/inner' && /bin/bash '$PE_SCRIPTS/phase-graph.sh' demo --ready"
  [ "$status" -eq 0 ]
  [ "$output" = "1" ]
}
